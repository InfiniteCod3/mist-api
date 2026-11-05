import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { DISPLAY, pageExpression, pageSnapshot, RECORDED } from "../bin/page";
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
