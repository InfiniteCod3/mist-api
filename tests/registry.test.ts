import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";

import { createMist, MIST_VERSION } from "../src/index";
import { copyOfSources } from "./copies";
import { fakeContext, mistNative } from "./helpers";

const copy = copyOfSources("0.0.1-old");
const old: typeof import("../src/index") = await import(join(copy.dir, "index.ts"));
afterAll(copy.remove);

test("plugins on two copies at different versions share one window.Mist, each answering with its own methods", () => {
    const current = createMist("t-current");
    const other = old.createMist("t-other");
    const a = current.define({});
    const b = other.define({});
    a.start!(fakeContext(mistNative(false)).ctx);
    b.start!(fakeContext(mistNative(false)).ctx);
    other.log.error("from the other copy");

    const Mist = (globalThis as any).Mist;
    const listed = Object.fromEntries(Mist.list().map((h: any) => [h.id, h.mistVersion]));
    expect(listed["t-current"]).toBe(MIST_VERSION);
    expect(listed["t-other"]).toBe("0.0.1-old");

    const status = Object.fromEntries(Mist.status().map((s: any) => [s.id, s]));
    expect(status["t-other"].state.mistVersion).toBe("0.0.1-old");
    expect(status["t-other"].state.errors.logs).toBe(1);
    expect(status["t-current"].state.errors.logs).toBe(0);
});

test("a hot reload replaces the plugin's handle", () => {
    const first = createMist("t-reload");
    first.define({});
    first.log.info("first copy");
    const second = old.createMist("t-reload");
    second.define({});
    const Mist = (globalThis as any).Mist;
    expect(Mist.get("t-reload").mistVersion).toBe("0.0.1-old");
    expect(Mist.get("t-reload").logs()).toEqual([]);
});

test("status reports the plugin's patch and lookup problems from Evi's diagnosis", () => {
    const mist = createMist("t-health");
    mist.define({});
    (globalThis as any).Evi = {
        diagnosePatches: () => [
            { plugin: "t-health", index: 0, health: "applied", errors: [], patch: { find: "a" } },
            { plugin: "t-health", index: 1, health: "broken", errors: [], patch: { find: /b\.c/ } },
            { plugin: "someone-else", index: 0, health: "failed", errors: ["x"], patch: { find: "z" } },
        ],
        diagnoseLookups: (plugin?: string) => [
            { plugin: "t-health", target: "props sendMessage", health: "missing" },
            { plugin: "t-health", target: "store UserStore", health: "found" },
        ].filter(l => !plugin || l.plugin === plugin),
        plugins: { get: (id: string) => id === "t-health" ? { running: false, error: "start threw" } : undefined },
    };
    try {
        const status = (globalThis as any).Mist.status().find((s: any) => s.id === "t-health");
        expect(status.startError).toBe("start threw");
        expect(status.patches).toEqual({ total: 2, health: { applied: 1, broken: 1 }, problems: [{ index: 1, health: "broken", find: String(/b\.c/), errors: [] }] });
        expect(status.lookups.problems).toEqual([{ target: "props sendMessage", health: "missing" }]);
    } finally {
        delete (globalThis as any).Evi;
    }
});

test("a patch marked onDemand shows as waiting while its code isn't downloaded, and an unmarked one stays broken", async () => {
    const { onDemand } = await import("../src/index");
    const mist = createMist("t-ondemand");
    mist.define({});
    const lazy = onDemand({ find: "media-viewer", replace: { match: /x/, with: "y" } });
    (globalThis as any).Evi = {
        diagnosePatches: () => [
            { plugin: "t-ondemand", index: 0, health: "broken", errors: [], patch: lazy },
            { plugin: "t-ondemand", index: 1, health: "broken", errors: [], patch: { find: "gone" } },
            { plugin: "t-ondemand", index: 2, health: "failed", errors: ["no match"], patch: onDemand({ find: "loaded" }) },
        ],
    };
    try {
        const status = (globalThis as any).Mist.status().find((s: any) => s.id === "t-ondemand");
        expect(status.patches).toEqual({
            total: 3,
            health: { waiting: 1, broken: 1, failed: 1 },
            problems: [
                { index: 1, health: "broken", find: "gone", errors: [] },
                { index: 2, health: "failed", find: "loaded", errors: ["no match"] },
            ],
        });
    } finally {
        delete (globalThis as any).Evi;
    }
});

test("the CLI's patch listing reads the same onDemand mark as status", async () => {
    const { ON_DEMAND } = await import("../src/patches");
    const cli = await Bun.file(join(import.meta.dir, "..", "bin", "mist.ts")).text();
    expect(cli).toContain(ON_DEMAND);
});

test("the shared keys are fixed protocol names, not the package name, so copies installed under any name meet", async () => {
    const { registry } = await import("../src/registry");
    const { channel } = await import("../src/bus");
    const root = {};
    const installed = registry(root);
    channel<number>("t-keys", 1, root).subscribe(() => { });
    expect(Object.getOwnPropertySymbols(root).map(s => Symbol.keyFor(s))).toEqual(["mist-api.registry.v1", "mist-api.bus/channel/t-keys@1"]);
    expect((root as Record<symbol, unknown>)[Symbol.for("mist-api.registry.v1")]).toBe(installed);
});

/** A handle as page code can build one: its own class, whose private field holds a decoy */
function forged(id: string, running: boolean) {
    class Forged {
        readonly #capability = { call: async () => "decoy" };
    }
    const state = () => ({ id, mistVersion: "9.9.9", running, startedAt: 0, native: "mist", debug: true, errors: { calls: 0, logs: 0 } });
    return Object.assign(new Forged(), { id, mistVersion: "9.9.9", state, logs: () => [], calls: () => [], nativeLogs: async () => null, values: () => ({}), settings: () => null, call: async () => "decoy" }) as any;
}
const shared = () => (globalThis as any)[Symbol.for("mist-api.registry.v1")];

test("page code can't put its own handle in place of a running plugin's", () => {
    const mist = createMist("t-swap-running");
    mist.define({}).start!(fakeContext(mistNative(false), {}, "t-swap-running").ctx);
    const own = shared().get("t-swap-running");
    shared().register(forged("t-swap-running", true))();
    shared().register(forged("t-swap-running", false));
    expect(shared().get("t-swap-running")).toBe(own);
    expect(shared().history("t-swap-running")).toEqual({ registered: 1, replaced: 0, refused: 2, reclaimed: 0 });
    expect(shared().concerns("t-swap-running")).toEqual(["2 registrations were refused while t-swap-running's handle said it was running: two handles claim this id"]);
});

test("a handle swapped in while the plugin was stopped is taken back at the plugin's next start, and flagged", () => {
    const mist = createMist("t-swap-stopped");
    const definition = mist.define({});
    const own = shared().get("t-swap-stopped");
    shared().register(forged("t-swap-stopped", false));
    expect(shared().get("t-swap-stopped")).not.toBe(own);
    definition.start!(fakeContext(mistNative(false), {}, "t-swap-stopped").ctx);
    expect(shared().get("t-swap-stopped")).toBe(own);
    expect(shared().history("t-swap-stopped")).toEqual({ registered: 3, replaced: 2, refused: 0, reclaimed: 1 });
    expect(shared().concerns("t-swap-stopped")).toEqual(["t-swap-stopped's handle was replaced while the plugin was stopped, and the plugin took it back at its next start"]);
    expect((globalThis as any).Mist.status().find((s: any) => s.id === "t-swap-stopped").concerns).toHaveLength(1);
});

test("a stand-in that says it runs keeps the id: the plugin warns, and the registry flags it", () => {
    const mist = createMist("t-swap-squat");
    const definition = mist.define({});
    const squatter = forged("t-swap-squat", true);
    shared().register(squatter);
    (globalThis as any).Evi = { plugins: { get: () => ({ running: false }) } };
    try {
        expect(shared().concerns("t-swap-squat")).toContain("t-swap-squat's handle says the plugin runs, but Evi says it is stopped");
    } finally {
        delete (globalThis as any).Evi;
    }
    const run = fakeContext(mistNative(false), {}, "t-swap-squat");
    definition.start!(run.ctx);
    expect(shared().get("t-swap-squat")).toBe(squatter);
    expect(run.printed.map(p => p.args[0])).toContain("Another handle holds t-swap-squat in the debug registry and says it is running, so `mist` can't reach this run");
    expect(shared().concerns("t-swap-squat")).toEqual(["1 registration was refused while t-swap-squat's handle said it was running: two handles claim this id"]);
});

test("a hot reload across copies at different versions replaces the handle once the old run stops, with no concerns", () => {
    for (const [first, second] of [[old, { createMist }], [{ createMist }, old]] as const) {
        const id = `t-reload-${first === old ? "up" : "down"}`;
        const before = first.createMist(id);
        const run = fakeContext(mistNative(false), {}, id);
        before.define({}).start!(run.ctx);
        run.dispose();
        const after = second.createMist(id);
        after.define({}).start!(fakeContext(mistNative(false), {}, id).ctx);
        expect(shared().get(id).mistVersion).toBe(first === old ? MIST_VERSION : "0.0.1-old");
        expect(shared().history(id)).toEqual({ registered: 2, replaced: 1, refused: 0, reclaimed: 0 });
        expect(shared().concerns(id)).toEqual([]);
    }
});

test("page code can't replace window.Mist with a lying status", () => {
    createMist("t-mist-global").define({});
    expect(() => Object.defineProperty(globalThis, "Mist", { value: { status: () => [] } })).toThrow();
    expect((globalThis as any).Mist.list().some((h: any) => h.id === "t-mist-global")).toBe(true);
});
