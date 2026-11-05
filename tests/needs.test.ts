import { afterAll, afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { createMist } from "../src/index";
import { registry } from "../src/registry";
import { copyOfSources } from "./copies";
import { fakeContext } from "../src/testing";
import { mistNative } from "./helpers";

const copy = copyOfSources("0.2.9-other");
const other: typeof import("../src/index") = await import(join(copy.dir, "index.ts"));
afterAll(copy.remove);

/** Evi's public plugin list: what's installed and evaluated, and who hears that it changed */
function fakeEvi(installed: Record<string, { name: string; evaluated?: boolean; }>) {
    const listeners = new Set<() => void>();
    (globalThis as any).Evi = {
        plugins: {
            get: (id: string) => installed[id] && { evaluated: installed[id].evaluated ?? true, running: true, manifest: { name: installed[id].name } },
            subscribe: (listener: () => void) => {
                listeners.add(listener);
                return () => void listeners.delete(listener);
            },
        },
    };
    return { changed: () => { for (const l of [...listeners]) l(); }, listeners };
}
afterEach(() => void delete (globalThis as any).Evi);

const warnings = (id: string) => (globalThis as any).Mist.get(id).state().warnings;

test("a needed plugin that provides an older version is a warning, a log line and one toast naming the plugin to update", () => {
    const evi = fakeEvi({ "t-feed-old": { name: "Weather Feed" } });
    const provider = other.createMist("t-feed-old", { provides: { "weather-feed": 1 } });
    provider.define({}).start!(fakeContext({ native: mistNative(false), id: "t-feed-old" }).ctx);

    const mist = createMist("t-needs-old", { needs: [{ plugin: "t-feed-old", protocol: "weather-feed", version: 2 }] });
    const definition = mist.define({});
    const run = fakeContext({ native: mistNative(false), id: "t-needs-old" });
    definition.start!(run.ctx);
    expect(warnings("t-needs-old")).toEqual(["Weather Feed (t-feed-old) provides weather-feed version 1, and t-needs-old speaks version 2: update Weather Feed"]);
    expect(run.logs.filter(p => p.level === "warn").map(p => p.args[0])).toEqual(warnings("t-needs-old"));
    expect(run.toasts).toEqual(["t-needs-old needs a newer version of Weather Feed. Update Weather Feed to use them together."]);

    evi.changed();
    run.dispose();
    expect(evi.listeners.size).toBe(0);
    const again = fakeContext({ native: mistNative(false), id: "t-needs-old" });
    definition.start!(again.ctx);
    expect(warnings("t-needs-old")).toHaveLength(1);
    expect(again.toasts).toEqual([]);
});

test("a needed plugin whose copy of mist says nothing about what it provides is a warning", () => {
    fakeEvi({ "t-feed-silent": { name: "Notes Sync" } });
    // An older copy's handle: no `provides`
    registry().register({ id: "t-feed-silent", mistVersion: "0.2.1", state: () => ({ running: true }) } as any);
    const mist = createMist("t-needs-silent", { needs: [{ plugin: "t-feed-silent", protocol: "notes", version: 1 }] });
    const run = fakeContext({ native: mistNative(false), id: "t-needs-silent" });
    mist.define({}).start!(run.ctx);
    expect(warnings("t-needs-silent")).toEqual(["Notes Sync (t-feed-silent) doesn't say it provides notes, and t-needs-silent speaks version 1: update Notes Sync"]);
    expect(run.toasts).toHaveLength(1);
});

test("a needed plugin that provides a newer version says to update this plugin", () => {
    fakeEvi({ "t-feed-new": { name: "Weather Feed" } });
    other.createMist("t-feed-new", { provides: { "weather-feed": 3 } }).define({});
    const run = fakeContext({ native: mistNative(false), id: "t-needs-new" });
    createMist("t-needs-new", { needs: [{ plugin: "t-feed-new", protocol: "weather-feed", version: 2 }] }).define({}).start!(run.ctx);
    expect(warnings("t-needs-new")[0]).toMatch(/version 3, and t-needs-new speaks version 2: update t-needs-new$/);
    expect(run.toasts).toEqual(["Weather Feed is newer than t-needs-new supports. Update t-needs-new to use them together."]);
});

test("copies at different versions meet on the same protocol version, and an update of the other plugin clears the warning", () => {
    const evi = fakeEvi({ "t-feed-update": { name: "Weather Feed" } });
    const before = other.createMist("t-feed-update", { provides: { "weather-feed": 1 } });
    const run = fakeContext({ native: mistNative(false), id: "t-feed-update" });
    before.define({}).start!(run.ctx);
    const mist = createMist("t-needs-update", { needs: [{ plugin: "t-feed-update", protocol: "weather-feed", version: 2 }] });
    mist.define({}).start!(fakeContext({ native: mistNative(false), id: "t-needs-update" }).ctx);
    expect(warnings("t-needs-update")).toHaveLength(1);

    // The user updates it: Evi stops the old run, then the new code registers
    run.dispose();
    other.createMist("t-feed-update", { provides: { "weather-feed": 2 } }).define({});
    evi.changed();
    expect((globalThis as any).Mist.get("t-feed-update").provides).toEqual({ "weather-feed": 2 });
    expect(warnings("t-needs-update")).toEqual([]);
});

test("a needed plugin that isn't installed, or that Evi hasn't evaluated because it is off, isn't judged", () => {
    fakeEvi({ "t-feed-off": { name: "Off", evaluated: false } });
    const run = fakeContext({ native: mistNative(false), id: "t-needs-none" });
    createMist("t-needs-none", {
        needs: [{ plugin: "t-feed-missing", protocol: "a", version: 1 }, { plugin: "t-feed-off", protocol: "b", version: 1 }],
    }).define({}).start!(run.ctx);
    expect(warnings("t-needs-none")).toEqual([]);
    expect(run.toasts).toEqual([]);
});

test("a needed plugin that is turned off isn't judged even after Evi evaluated it, and is once it is turned on", () => {
    const { changed } = fakeEvi({ "t-feed-was-on": { name: "Was on" }, "t-feed-default": { name: "Default" } });
    const evi = (globalThis as any).Evi;
    const switches: Record<string, { enabled?: boolean; }> = { "t-feed-was-on": { enabled: false } };
    evi.settings = { data: { plugins: switches } };
    const get = evi.plugins.get;
    evi.plugins.get = (id: string) => {
        const info = get(id);
        return info && { ...info, running: switches[id]?.enabled === true, manifest: { ...info.manifest, enabledByDefault: id === "t-feed-default" } };
    };
    const run = fakeContext({ native: mistNative(false), id: "t-needs-off" });
    createMist("t-needs-off", {
        needs: [{ plugin: "t-feed-was-on", protocol: "a", version: 1 }, { plugin: "t-feed-default", protocol: "b", version: 1 }],
    }).define({}).start!(run.ctx);
    // On by default, and nobody turned it off: judged, though it isn't running yet
    expect(warnings("t-needs-off")).toEqual(["Default (t-feed-default) doesn't say it provides b, and t-needs-off speaks version 1: update Default"]);

    switches["t-feed-was-on"].enabled = true;
    changed();
    expect(warnings("t-needs-off")).toHaveLength(2);
    run.dispose();
});

test("the handle and its state advertise what the plugin provides, and a bad version is refused", () => {
    createMist("t-provides", { provides: { "weather-feed": 2 } }).define({});
    const handle = (globalThis as any).Mist.get("t-provides");
    expect(handle.provides).toEqual({ "weather-feed": 2 });
    expect(Object.isFrozen(handle.provides)).toBe(true);
    expect(handle.state().provides).toEqual({ "weather-feed": 2 });
    expect(() => createMist("t-provides-bad", { provides: { "weather-feed": 0 } })).toThrow(/whole version/);
});
