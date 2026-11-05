import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { codeOffset, errorLines, type ErrorRecord, parseStack } from "../bin/errors";
import { growth } from "../bin/leaks";
import { builtBytes, fixLines, fixManifest, fixManifestDir, LANGUAGES, type Manifest, MAX_BYTES } from "../bin/manifest";
import { diffTokens, tokens } from "../bin/module";
import { perfLines } from "../bin/perf";
import { MASKED } from "../src/values";

/** A scenario of tests/fixtures/cli-extras-page.ts: the CLI's code over Node's inspector, which speaks the same CDP as Discord's page */
const scenario = (name: string, ...args: string[]) => JSON.parse(execFileSync("node", [join(import.meta.dir, "fixtures", "cli-extras-page.ts"), name, ...args], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }));

/** A plugin bundle as Evi's watch build makes it: CommonJS with an inline source map */
async function watchBuild(name = "plugin.ts", lines = [
    "export function boom(): never {",
    "    const reason: string = \"kaput\";",
    "    throw new Error(reason);",
    "}",
]) {
    const dir = mkdtempSync(join(tmpdir(), "mist-errors-"));
    writeFileSync(join(dir, name), [...lines, ""].join("\n"));
    const built = await Bun.build({ entrypoints: [join(dir, name)], outdir: join(dir, "out"), target: "browser", format: "cjs", sourcemap: "inline" });
    expect(built.success).toBe(true);
    return built.outputs[0].path;
}

test("mist errors reads the errors the page kept and new ones, masked, attributed by Evi's logger, by stack and by patched module", async () => {
    const { records, replayedAt, listening } = scenario("errors", await watchBuild()) as { records: ErrorRecord[]; replayedAt: number; listening: number; };
    const brief = records.map(r => [r.source, r.plugins, r.via, r.text.split("\n")[0]]);
    expect(brief.slice(0, replayedAt)).toEqual([
        ["console", ["demo-plugin"], "logger", `Flux handler for MESSAGE_CREATE threw {"token":"${MASKED}","n":1}`],
        ["console", ["other-plugin"], "logger", "[Hooks] after hook of other-plugin on render threw Error: hook failed"],
        ["console", ["mapped-plugin"], "stack", "Error: kaput"],
    ]);
    expect(brief.slice(replayedAt)).toEqual([
        ["exception", ["patcher"], "patched module", "TypeError: x is undefined"],
        ["log", [], null, "network: Failed to load resource (https://example.com/a)"],
        ["log", [], null, `network: POST https://discord.com/api/webhooks/123/${MASKED} 404 (https://discord.com/api/webhooks/123/${MASKED})`],
        ["exception", [], null, "Error: at a signed URL"],
        ["console", ["alpha", "beta"], "logger", "[Webpack] Module 12 threw. It was patched by: alpha, beta Error: bad module"],
    ]);
    for (const secret of ["secret-1", "hook-token-1", "wait=true", "sig-1", "frag"]) expect(JSON.stringify(records)).not.toContain(secret);
    const signed = records.find(r => r.text.startsWith("Error: at a signed URL"))!;
    expect([signed.text.split("\n")[1], signed.frames[0].url]).toEqual(["    at load (https://cdn.discordapp.com/assets/web.js:1:20)", "https://cdn.discordapp.com/assets/web.js"]);
    const mapped = records[2].frames[0];
    expect(mapped.url).toBe("evi://plugins/mapped-plugin.js");
    expect([mapped.original?.source.endsWith("plugin.ts"), mapped.original?.line]).toEqual([true, 3]);
    expect(errorLines(records[2], () => "t")[1]).toMatch(/^ {4}at Object\.boom \(.*plugin\.ts:3:11\)$/);
    expect(listening).toBe(0);
}, 30_000);

test("mist errors maps a frame through the build it ran in, and leaves a stack text's frame unmapped when its URL has several builds", async () => {
    const old = await watchBuild("old.ts", ["export function complain(): void {", "    console.error(\"complaint\");", "}", "export function boom(): never {", "    throw new Error(\"old build\");", "}"]);
    const newer = await watchBuild("new.ts", ["export const a = 1;", "export const b = 2;", "export function complain(): void {", "    console.error(\"complaint\");", "}", "export function boom(): never {", "    throw new Error(\"new build\");", "}"]);
    const records = scenario("errorsAcrossBuilds", old, newer) as { text: string; plugins: string[]; original: { source: string; line: number; } | null; }[];
    expect(records.map(r => [r.text, r.plugins])).toEqual([["complaint", ["twice-plugin"]], ["Error: old build", ["twice-plugin"]]]);
    expect([records[0].original?.source.endsWith("old.ts"), records[0].original?.line]).toEqual([true, 2]);
    expect(records[1].original).toBeNull();
}, 30_000);

test("mist errors and mist module never let Discord's page pause: pauses are skipped before the debugger is on, a pause that comes anyway is resumed, and a failed skip turns nothing on", () => {
    const r = scenario("pauses");
    for (const name of ["errors", "module"]) {
        expect(r[name].skipped).toEqual({ paused: 0, resumed: false, enabled: true, error: null });
        expect([r[name].ignored.paused, r[name].ignored.resumed]).toEqual([1, true]);
        expect(r[name].fails).toEqual({ paused: 0, resumed: false, enabled: false, error: "mist didn't turn on Discord's debugger: it couldn't make it skip pauses first (not now), and a pause would freeze Discord" });
    }
}, 30_000);

test("mist errors reads frames from a stack's text, with and without a function name", () => {
    expect(parseStack("Error: x\n    at render (evi://plugins/a.js:3:7)\n    at https://discord.com/assets/web.js:1:20\n    at <anonymous>")).toEqual([
        { fn: "render", url: "evi://plugins/a.js", line: 3, column: 7 },
        { fn: "", url: "https://discord.com/assets/web.js", line: 1, column: 20 },
    ]);
});

test("mist errors lines a plugin's map up with the code inside Evi's wrapper, whose first line starts mid-line", () => {
    const script = "(function anonymous(fetch\n) {\nreturn function (module, exports, require) {var a = 1;\n};";
    expect(codeOffset(script)).toEqual({ line: 2, column: 44 });
    expect(codeOffset("var a = 1;")).toEqual({ line: 0, column: 0 });
});

test("mist perf lists each plugin's sites, and the applied patches none of whose $self functions ran", () => {
    const report = scenario("perf");
    expect(report.unrun).toEqual([{ plugin: "alpha", index: 1, find: "b", names: ["unused", "alsoUnused"], modules: ["2"] }]);
    expect(report.unreadable).toBe(1);
    const lines = perfLines(report, 5);
    expect(lines[0]).toBe("Evi on module loading: 10 modules, 2 patched, patching 1.5 ms, listeners 0.5 ms");
    expect(lines).toContain("    patch   $self.used  3.0 ms in 12, slowest 1.0 ms");
    expect(lines).toContain("  alpha #1 find b  modules 2  never called: $self.unused, $self.alsoUnused");
});

test("mist dev prints each hot reload once it settles, a reload that failed, ignores a language change, and unsubscribes", () => {
    const { outcomes, listeners, missing } = scenario("dev");
    expect(outcomes).toEqual([
        { reloaded: true, version: "1.1.0", running: true, error: null, needsReload: false, patches: { health: { applied: 2 }, problems: [] } },
        { reloaded: false, version: "1.1.0", running: false, error: "SyntaxError: Unexpected token", needsReload: false, patches: null },
        { reloaded: true, version: "1.2.0", running: false, error: "TypeError: boom", needsReload: true, patches: { health: { applied: 2 }, problems: [] } },
    ]);
    expect(listeners).toBe(0);
    expect(missing).toStartWith("nope isn't installed");
}, 30_000);

test("mist module reads the patched copy Evi compiled, diffs it, and says which patch each change is likely from", () => {
    const r = scenario("module");
    expect([r.id, r.loaded, r.patchedBy, r.patchedSame, r.byText]).toEqual(["77", true, ["alpha #0", "beta #3"], true, "77"]);
    // Changes this close together are one hunk, and it names both patches
    expect(r.hunks).toEqual([{ removed: "e.foo(1); return x + t.bar", added: `Evi.$("alpha").wrap(e.foo(1)); return x + t.baz`, plugins: ["alpha", "beta"], certain: true }]);
    // Evi's `function` in place of `66` moves every position; the match is measured where the diff runs
    expect(r.shorthand).toEqual([{ removed: "bar", added: "baz", plugins: ["delta"], certain: true }]);
    expect(r.unpatched).toBeNull();
    expect(r.many).toStartWith("2 modules contain function: 77, 88");
    expect(r.none).toBe("No webpack module has the id or the text no such text anywhere");
}, 30_000);

test("the module diff gives back both sources, and gives up past its edit budget", () => {
    for (let i = 0; i < 200; i++) {
        const random = () => Array.from({ length: 25 }, () => "ab c"[Math.floor(Math.random() * 4)]);
        const [a, b] = [random(), random()];
        const ops = diffTokens(a, b)!;
        expect(ops.filter(o => o.kind !== "add").map(o => o.text).join("")).toBe(a.join(""));
        expect(ops.filter(o => o.kind !== "del").map(o => o.text).join("")).toBe(b.join(""));
    }
    expect(diffTokens(tokens("a b c d e f"), tokens("1 2 3 4 5 6"), 3)).toBeNull();
});

test("mist react lists the components above an element, masks their props, and marks the ones Evi hooked", () => {
    const { tree, none } = scenario("react");
    expect(tree.matches).toBe(2);
    expect(tree.components).toEqual([
        { name: "span.name", kind: "host", props: { className: "name", children: "hi" }, hooked: false, hookedBy: [] },
        { name: "UserCard", kind: "function", props: { user: { name: "a", token: MASKED }, children: "[2 children]" }, hooked: true, hookedBy: ["hooker"] },
        { name: "Row", kind: "memo", props: { id: 3 }, hooked: false, hookedBy: [] },
    ]);
    expect(none).toEqual({ matches: 0, components: [] });
}, 30_000);

test("mist react masks a password input's value and default, and the value of an input autocompleted as a password or one-time code", () => {
    const { password } = scenario("react");
    expect(password.components.map((c: { props: unknown; }) => c.props)).toEqual([
        { type: "password", value: MASKED, defaultValue: MASKED, name: "pw" },
        { autoComplete: "one-time-code", value: MASKED, label: "Code" },
        { value: "shown" },
    ]);
}, 30_000);

test("mist leaks finds what grows with every cycle, leaves the plugin on, and refuses anything but a running dev build before switching it", () => {
    const r = scenario("leaks");
    expect(r.leaky).toEqual({ styles: 1, subscribers: 1 });
    expect([r.leakySwitches, r.leakyRunning]).toEqual([6, true]);
    expect([r.clean, r.cleanRunning]).toEqual([{}, true]);
    expect(r.installed).toBe("mist leaks turns plugins off and on, so it runs only on dev builds, and installed is a store install");
    expect(r.off).toBe("off isn't running: turn it on first, so mist leaks can leave it as it was");
    expect(r.native).toBe("native has a native side, so Evi shows a yes or no dialog each time it is turned on: mist leaks can't turn it on again by itself");
    expect(r.chromiumSwitches).toBe("switches has Chromium switches, so Evi shows a yes or no dialog each time it is turned on: mist leaks can't turn it on again by itself");
    expect(r.refusedSwitches).toBe(0);
}, 30_000);

test("mist leaks turns the plugin on again when turning it off fails, and when it is stopped between steps", () => {
    const r = scenario("leaks");
    expect([r.failsOff, r.failsOffRunning]).toEqual([expect.stringContaining("stop threw"), true]);
    expect([r.stopped, r.stoppedRunning]).toEqual(["mist leaks stopped at Ctrl+C. stoppable is on.", true]);
}, 30_000);

test("mist leaks doesn't call one cycle's rise a leak", () => {
    const counts = (n: number) => ({ nodes: n, styles: 1, subscribers: 1, interceptors: 0, listeners: null });
    expect(growth(counts(10), [{ off: counts(11), on: counts(12) }])).toEqual({});
    expect(growth(counts(10), [{ off: counts(11), on: counts(12) }, { off: counts(11), on: counts(14) }])).toEqual({});
    expect(growth(counts(10), [{ off: counts(11), on: counts(12) }, { off: counts(13), on: counts(14) }])).toEqual({ nodes: 2 });
});

const manifest = (extra: Partial<Manifest> = {}): Manifest => ({
    id: "demo", name: "Demo", description: "Does a thing.", version: "1.2.0",
    changelog: [{ version: "1.2.0", notes: ["New."] }, { version: "1.1.0", notes: ["Old."] }, { version: "1.0.0", notes: ["First."] }],
    ...extra,
});

test("mist manifest fix lists each missing translation and with --write adds the English text in its place", () => {
    const dir = mkdtempSync(join(tmpdir(), "mist-manifest-"));
    const path = join(dir, "manifest.json");
    const original = JSON.stringify(manifest({ locales: { de: { name: "Demo", description: "Tut etwas.", changelog: { "1.2.0": ["Neu."] } } } }), null, 4);
    writeFileSync(path, original);

    const report = fixManifestDir(dir, false);
    expect(report.missing).toHaveLength((LANGUAGES.length - 1) * 3);
    expect(report.missing.slice(0, 3)).toEqual(["es name", "es description", "es 1.2.0 notes"]);
    expect([report.written, readFileSync(path, "utf8")]).toEqual([false, original]);

    expect(fixManifestDir(dir, true).written).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.locales.de).toEqual({ name: "Demo", description: "Tut etwas.", changelog: { "1.2.0": ["Neu."] } });
    expect(written.locales.fr).toEqual({ name: "Demo", description: "Does a thing.", changelog: { "1.2.0": ["New."] } });
    expect(fixManifestDir(dir, false).missing).toEqual([]);
});

test("mist manifest fix drops other languages' notes for the oldest versions until the built manifest fits Evi's 16 KB", () => {
    const long = (lang: string, version: string) => [`${lang} ${version} ${"x".repeat(450)}`];
    const locales = Object.fromEntries(LANGUAGES.map(lang => [lang, {
        name: "Demo", description: "D", changelog: Object.fromEntries(["1.0.0", "1.1.0", "1.2.0"].map(v => [v, [...long(lang, v), ...long(lang, v), ...long(lang, v)]])),
    }]));
    const input = manifest({ locales });
    const bytes = builtBytes(input, "demo", false);
    expect(bytes).toBeGreaterThan(MAX_BYTES);

    const fix = fixManifest(input, "demo", false);
    expect(fix.trimmed).toEqual(["1.0.0", "1.1.0"]);
    expect(fix.bytes).toEqual({ before: bytes, after: builtBytes(fix.manifest, "demo", false) });
    expect(fix.bytes.after).toBeLessThanOrEqual(MAX_BYTES);
    expect([fix.over, Object.keys(fix.manifest.locales!.de.changelog!)]).toEqual([0, ["1.2.0"]]);
    expect(fix.manifest.changelog).toEqual(input.changelog);
    expect(input.locales!.de.changelog!["1.0.0"]).toBeDefined();
});

test("mist manifest fix says how far over a manifest stays when its current notes alone are too long", () => {
    const huge = Object.fromEntries(LANGUAGES.map(lang => [lang, { name: "Demo", description: "D", changelog: { "1.2.0": Array.from({ length: 20 }, () => "y".repeat(400)) } }]));
    const fix = fixManifest(manifest({ locales: huge }), "demo", true);
    expect(fix.trimmed).toEqual([]);
    expect(fix.over).toBe(fix.bytes.after - MAX_BYTES);
    expect(fix.over).toBeGreaterThan(0);
});

test("mist manifest fix asks for every language's notes when this version's entry has none, as Evi's check does", () => {
    const locales = Object.fromEntries(LANGUAGES.map(lang => [lang, { name: "Demo", description: "D", changelog: { "1.2.0": [] } }]));
    const fix = fixManifest(manifest({ changelog: [{ version: "1.2.0", notes: [] }], locales }), "demo", false);
    expect(fix.missing).toEqual(LANGUAGES.map(lang => `${lang} 1.2.0 notes`));
});

test("mist manifest fix drops a prerelease's notes before its release's", () => {
    const notes = (lang: string, v: string) => Array.from({ length: 3 }, () => `${lang} ${v} ${"x".repeat(250)}`);
    const locales = Object.fromEntries(LANGUAGES.map(lang => [lang, {
        name: "Demo", description: "D", changelog: Object.fromEntries(["1.1.0-beta.10", "1.1.0", "1.1.0-beta.2", "1.2.0"].map(v => [v, notes(lang, v)])),
    }]));
    const fix = fixManifest(manifest({ locales }), "demo", false);
    expect(fix.over).toBe(0);
    expect(fix.trimmed).toEqual(["1.1.0-beta.2", "1.1.0-beta.10"]);
    expect(Object.keys(fix.manifest.locales!.de.changelog!)).toContain("1.1.0");
});

test("mist manifest fix drops and writes nothing when even dropping every old translated note wouldn't fit, and says how far over it is", () => {
    const locales = Object.fromEntries(LANGUAGES.map(lang => [lang, {
        name: "Demo", changelog: { "1.2.0": Array.from({ length: 6 }, () => "y".repeat(400)), "1.1.0": ["z".repeat(400)] },
    }]));
    const dir = mkdtempSync(join(tmpdir(), "mist-manifest-"));
    const path = join(dir, "manifest.json");
    const original = JSON.stringify(manifest({ locales }), null, 4);
    writeFileSync(path, original);

    const r = fixManifestDir(dir, true);
    expect(r.trimmed).toEqual([]);
    expect(Object.keys(r.manifest.locales!.fr.changelog!)).toEqual(["1.2.0", "1.1.0"]);
    expect(r.over).toBeGreaterThan(0);
    const allOldDropped = structuredClone(r.manifest);
    for (const locale of Object.values(allOldDropped.locales!)) delete locale.changelog!["1.1.0"];
    expect(r.over).toBe(builtBytes(allOldDropped, basename(dir), false) - MAX_BYTES);
    expect([r.written, readFileSync(path, "utf8")]).toEqual([false, original]);
    expect(fixLines(r)).toContain(`${r.over} bytes over even with every old translated note gone, so nothing is dropped and nothing written: shorten the English changelog or this version's translations.`);
});
