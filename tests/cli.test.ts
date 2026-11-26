import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { CliError } from "../bin/cdp";
import { freshRecords } from "../bin/logs";
import { DISPLAY, pageExpression, pageSnapshot, RECORDED } from "../bin/page";
import { discordUpdater } from "../bin/restart";
import { readable } from "../bin/store";
import { MASKED, snapshot } from "../src/values";

/** A scenario of tests/fixtures/cli-page.ts: the CLI's page code over Node's inspector, which speaks the same CDP as Discord's page */
const scenario = (name: string) => JSON.parse(execFileSync("node", [join(import.meta.dir, "fixtures", "cli-page.ts"), name], { encoding: "utf8", timeout: 20_000 }));

const uncapped = { ...RECORDED, nodes: Number.MAX_SAFE_INTEGER };

test("the page's snapshot keeps src/values.ts's rules: masking, bounds, and every kind of value", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    let deep: unknown = "bottom";
    for (let i = 0; i < 8; i++) deep = { deep };
    const values: unknown[] = [
        { user: "a", accessToken: "abc", nested: { password: "p", list: [{ cookie: "c" }] }, emptyToken: "", nullSecret: null },
        { input_tokens: 12, maxTokens: 4, tokens: "t" },
        new Map<unknown, unknown>([["session", "s"], ["name", "n"], [1, "one"]]),
        new Set([1, "two", { authorization: "Bearer x" }]),
        { list: Array.from({ length: 60 }, (_, i) => i), text: "x".repeat(2500), keys: Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`k${i}`, i])) },
        { error: new TypeError("bad"), date: new Date(0), invalid: new Date(NaN), re: /a+/g, big: 10n, sym: Symbol("s"), fn: function named() { }, nan: NaN, undef: undefined },
        circular,
        deep,
        [{ get boom() { throw new Error("getter"); } }],
    ];
    for (const value of values) expect(pageSnapshot(value, uncapped)).toEqual(snapshot(value));
});

test("the page's snapshot cuts to the display bounds, and stops copying objects past its budget", () => {
    const shot = pageSnapshot({ list: Array.from({ length: 30 }, (_, i) => i), text: "y".repeat(500), secret: "s" }, DISPLAY) as { list: unknown[]; text: string; secret: string; };
    expect(shot.list).toHaveLength(11);
    expect(shot.list[10]).toBe("…(+20 items)");
    expect(shot.text).toBe(`${"y".repeat(200)}…(+300 chars)`);
    expect(shot.secret).toBe(MASKED);
    const wide = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => ({ a: 1 })));
    expect(JSON.stringify(pageSnapshot(wide, { ...DISPLAY, nodes: 20 }))).toContain('"…"');
});

test("page code runs with nothing from its module: a fresh context evaluates the expression", () => {
    const expression = pageExpression((snap: typeof pageSnapshot, value: unknown, limits: typeof DISPLAY) => snap(value, limits), [{ apiKey: "k", n: 1 }, DISPLAY], true);
    expect(runInNewContext(expression)).toEqual({ apiKey: MASKED, n: 1 });
});

test("mist store calls only methods named as reads", () => {
    for (const name of ["getUser", "isEnabled", "hasLoaded", "findByTag", "canFetch", "shouldShow", "areAll", "supportsX", "getState", "get"]) expect([name, readable(name)]).toEqual([name, true]);
    for (const name of ["setChannel", "getOrCreatePendingEdit", "getAndDeleteMostRecentUserCreatedThreadId", "getter", "initialize", "forEach", "isolate", "clear", "handleLoad"]) expect([name, readable(name)]).toEqual([name, false]);
});

test("mist flux with types prints those actions, masked, stops at the count, and unsubscribes", () => {
    const { seen, after } = scenario("types");
    expect(seen.records.map((r: { type: string; payload: unknown; }) => [r.type, r.payload])).toEqual([["A", { n: 1, token: MASKED }], ["A", { n: 2 }]]);
    expect(after).toEqual({ interceptors: 0, subscriptions: [] });
}, 30_000);

test("mist flux -n counts only the actions it could copy, so one it couldn't doesn't leave it waiting forever", () => {
    const { seen, after } = scenario("unreadable");
    expect(seen.records.map((r: { payload: unknown; }) => r.payload)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(after).toEqual({ interceptors: 0, subscriptions: [] });
}, 30_000);

test("mist flux without types sees every action through an interceptor that never skips one, and takes it out", () => {
    const { seen, other, after } = scenario("every");
    expect(seen.records.map((r: { type: string; }) => r.type)).toEqual(["A", "B", "C"]);
    expect(other).toEqual(["A", "B", "C", "D"]);
    expect(after).toEqual({ interceptors: 1, subscriptions: [] });
}, 30_000);

test("mist flux -f stops when interrupted and unsubscribes in the page", () => {
    const { seen, after } = scenario("interrupted");
    expect(seen.records.map((r: { type: string; }) => r.type)).toEqual(["A"]);
    expect(after).toEqual({ interceptors: 0, subscriptions: [] });
}, 30_000);

test("the page drops a watch the CLI stopped reading, and the CLI hears it ended", () => {
    const { seen, after } = scenario("abandoned");
    expect(seen.alive).toEqual([false]);
    expect(after).toEqual({ interceptors: 0, subscriptions: [] });
}, 30_000);

test("the page keeps the newest 1000 actions between reads and counts the ones it dropped", () => {
    expect(scenario("flood")).toEqual({ first: { n: 5 }, kept: 1000, dropped: 5 });
}, 30_000);

test("stopping a watch that isn't there changes nothing", () => {
    expect(scenario("stopTwice")).toEqual([0, { interceptors: 0, subscriptions: [] }]);
}, 30_000);

test("mist store lists a store's own methods and getState keys, calls reads with masking by field and method name, and refuses the rest before sending", () => {
    const answer = scenario("store");
    expect(answer.methods).toEqual({
        store: "ThingStore",
        methods: [
            { name: "getAuthToken", readable: true },
            { name: "getOrCreateThing", readable: false },
            { name: "getState", readable: true },
            { name: "getThing", readable: true },
            { name: "getTokens", readable: true },
            { name: "isOn", readable: true },
            { name: "setThing", readable: false },
        ],
        stateKeys: ["things", "selected"],
    });
    expect(answer.thing).toEqual({ id: "7", name: "thing", authToken: MASKED, tags: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, "…(+20 items)"] });
    expect(answer.on).toBe(true);
    expect([answer.token, answer.tokens]).toEqual([MASKED, 3]);
    expect(answer.set).toStartWith("setThing isn't named as a read");
    expect(answer.create).toStartWith("getOrCreateThing isn't named as a read");
    expect(answer.sets).toBe(0);
    expect(answer.missingStore).toStartWith("No Flux store is named NoStore");
    expect(answer.missingMethod).toBe("ThingStore has no method getNothing (mist store ThingStore lists them)");
}, 30_000);

/** The mist CLI from source, as a user runs it */
function mist(...args: string[]) {
    const run = spawnSync("node", [join(import.meta.dir, "..", "bin", "mist.ts"), ...args], { encoding: "utf8", timeout: 20_000 });
    const stderr = run.stderr.split("\n").filter(line => line && !/Reparsing|"type": "module"|trace-warnings|MODULE_TYPELESS/.test(line)).join("\n");
    return { code: run.status, stdout: run.stdout, stderr };
}

function manifestDir() {
    const dir = mkdtempSync(join(tmpdir(), "mist-cli-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id: "demo", name: "Demo", version: "1.2.0", changelog: [{ version: "1.2.0", notes: ["New."] }] }, null, 4));
    return dir;
}

test("mist refuses an option it doesn't know before it connects, rather than reading it as an argument", () => {
    expect(mist("status", "--jsno")).toEqual({ code: 1, stdout: "", stderr: `Unknown option --jsno. Run "mist help" for options, or use "--" before positional arguments.` });
    expect(mist("nope").stderr).toStartWith("Unknown command nope");
    expect(mist("--help").stdout).toStartWith("mist <command> [options]");
});

test("mist refuses a command missing its arguments before it connects, with the command's usage", () => {
    expect(mist("logs")).toEqual({ code: 1, stdout: "", stderr: "mist logs needs a plugin id (mist status lists them)\nUsage: mist logs <id> [-f]" });
    expect(mist("call", "demo")).toEqual({ code: 1, stdout: "", stderr: "mist call needs a method name\nUsage: mist call <id> <method> [args]" });
    expect(mist("eval").stderr).toStartWith("mist eval needs an expression");
    expect(mist("manifest").stderr).toStartWith("mist manifest needs a subcommand: fix or bump\nUsage: mist manifest fix [dir]");
});

test("mist refuses a --port outside 1 to 65535 and a bad -n", () => {
    for (const port of ["70000", "0", "1.5", "x"]) {
        expect(mist("status", "--port", port)).toEqual({ code: 1, stdout: "", stderr: "--port must be a whole number from 1 to 65535" });
    }
    for (const count of ["0", "-2", "1.5", "x"]) {
        expect(mist("logs", "demo", "-n", count)).toEqual({ code: 1, stdout: "", stderr: "-n must be a whole number from 1" });
    }
});

test("mist --version and -v print the package's version", () => {
    const { version } = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    expect(mist("--version")).toEqual({ code: 0, stdout: `${version}\n`, stderr: "" });
    expect(mist("status", "-v").stdout).toBe(`${version}\n`);
});

test("with --json, an error prints as JSON on stdout", () => {
    expect(mist("logs", "--json")).toEqual({ code: 1, stdout: `${JSON.stringify({ error: "mist logs needs a plugin id (mist status lists them)\nUsage: mist logs <id> [-f]" })}\n`, stderr: "" });
    expect(JSON.parse(mist("status", "--json", "--port", "70000").stdout)).toEqual({ error: "--port must be a whole number from 1 to 65535" });
    // After --, --json is an argument
    expect(mist("logs", "--", "--json").stdout).not.toContain('"error"');
});

test("mist help lines up every description in one column", () => {
    const lines = mist("help").stdout.split("\n");
    // The width up to a row's description, or the indent of a description under a label too wide for its column
    const column = (line: string) => (/^  \S(?:.*?\S)? {2,}(?=\S)/.exec(line) ?? /^ {3,}(?=\S)/.exec(line))?.[0].length;
    const columns = lines.map(column).filter(width => width !== undefined);
    expect(columns.length).toBeGreaterThan(35);
    expect(new Set(columns)).toEqual(new Set([30]));
    expect(lines).toContain(`  --timeout <s>${" ".repeat(15)}restart --wait: how long to wait (default 60)`);
});

test("mist restart needs LOCALAPPDATA to find Discord's Update.exe", () => {
    expect(() => discordUpdater(undefined)).toThrow(new CliError("LOCALAPPDATA isn't set: mist restart can't find Discord's Update.exe. Start Discord with --remote-debugging-port yourself."));
    expect(() => discordUpdater("")).toThrow("LOCALAPPDATA isn't set");
    const local = mkdtempSync(join(tmpdir(), "mist-local-"));
    expect(() => discordUpdater(local)).toThrow(`No Discord installer at ${join(local, "Discord", "Update.exe")}`);
    mkdirSync(join(local, "Discord"));
    writeFileSync(join(local, "Discord", "Update.exe"), "");
    expect(discordUpdater(local)).toBe(join(local, "Discord", "Update.exe"));
});

test("mist runs offline commands without Discord, and reads -1 and what follows -- as arguments", () => {
    const dir = manifestDir();
    const bump = mist("manifest", "bump", dir, "patch", "--note", "Fixed a crash.", "--json");
    expect([bump.code, JSON.parse(bump.stdout).to]).toEqual([0, "1.2.1"]);
    expect(mist("manifest", "bump", dir, "-1", "--note", "x").stderr).toBe("-1 isn't a version: give patch, minor, major, or a version such as 1.2.3");
    expect(mist("manifest", "bump", "--note", "x", "--", dir, "--minor").stderr).toBe("--minor isn't a version: give patch, minor, major, or a version such as 1.2.3");
}, 30_000);

test("mist logs -f prints each line once, two identical lines in the same millisecond as two, and says when lines came too fast to read", () => {
    expect(freshRecords([], ["a", "b"], 50)).toEqual({ fresh: 2, dropped: false });
    expect(freshRecords(["a", "b"], ["a", "b"], 50)).toEqual({ fresh: 0, dropped: false });
    expect(freshRecords(["x"], ["x", "x"], 50)).toEqual({ fresh: 1, dropped: false });
    expect(freshRecords(["a", "b", "c"], ["b", "c", "d"], 3)).toEqual({ fresh: 1, dropped: false });
    expect(freshRecords(["a", "b", "c"], ["d", "e", "f"], 3)).toEqual({ fresh: 3, dropped: true });
    // A restarted plugin's log starts over: fewer lines than asked for, so none were missed
    expect(freshRecords(["a", "b", "c"], ["d"], 3)).toEqual({ fresh: 1, dropped: false });
});
