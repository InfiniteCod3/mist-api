import { expect, test } from "bun:test";

import { createMist, SETTINGS_VERSION } from "../src/index";
import { fakeContext } from "../src/testing";
import { mistNative } from "./helpers";

const settings = {
    city: { type: "string", label: "City", default: "" },
    units: { type: "select", label: "Units", default: "metric", options: [{ label: "Metric", value: "metric" }, { label: "Imperial", value: "imperial" }] },
} as const;

test("migrations run once each, in order of `to`, before start, and the version is stored with the plugin's settings", () => {
    const mist = createMist<typeof settings>("t-migrate");
    const ran: string[] = [];
    const definition = mist.define({
        settings,
        migrate: [
            { to: 2, run: s => { ran.push("2"); if (s.get("fahrenheit") === true) s.set("units", "imperial"); } },
            { to: 1, run: s => { ran.push("1"); const town = s.get("town"); if (typeof town === "string") s.set("city", town); } },
        ],
        start(ctx) { ran.push(`start ${ctx.settings.get("city")} ${ctx.settings.get("units")}`); },
    });
    expect(definition.migrate).toBeUndefined();

    // Stored by the plugin's previous version, under keys its schema no longer declares
    const stored: Record<string, any> = { town: "Berlin", fahrenheit: true };
    definition.start!(fakeContext({ native: mistNative(false), schema: settings, settings: stored }).ctx);
    expect(ran).toEqual(["1", "2", "start Berlin imperial"]);
    expect(stored[SETTINGS_VERSION]).toBe(2);

    ran.length = 0;
    definition.start!(fakeContext({ native: mistNative(false), schema: settings, settings: stored }).ctx);
    expect(ran).toEqual(["start Berlin imperial"]);
});

test("only the steps above the stored version run", () => {
    const mist = createMist<typeof settings>("t-migrate-partial");
    const ran: number[] = [];
    const definition = mist.define({ settings, migrate: [1, 2, 3].map(to => ({ to, run: () => void ran.push(to) })) });
    const stored: Record<string, any> = { [SETTINGS_VERSION]: 2 };
    definition.start!(fakeContext({ native: mistNative(false), schema: settings, settings: stored }).ctx);
    expect(ran).toEqual([3]);
    expect(stored[SETTINGS_VERSION]).toBe(3);
});

test("a migration that throws is logged and in status, the steps after it wait, the plugin still starts, and the next start tries it again", () => {
    const mist = createMist<typeof settings>("t-migrate-throws");
    let broken = true;
    const ran: string[] = [];
    const definition = mist.define({
        settings,
        migrate: [
            { to: 1, run: () => void ran.push("1") },
            { to: 2, run: () => { if (broken) throw new Error("bad shape"); ran.push("2"); } },
            { to: 3, run: () => void ran.push("3") },
        ],
        start() { ran.push("start"); },
    });
    const stored: Record<string, any> = {};
    const run = fakeContext({ native: mistNative(false), schema: settings, settings: stored });
    definition.start!(run.ctx);
    expect(ran).toEqual(["1", "start"]);
    expect(stored[SETTINGS_VERSION]).toBe(1);
    expect(run.logs.find(p => p.level === "error")?.args[0]).toMatch(/migration to 2 threw/);
    const Mist = (globalThis as any).Mist;
    expect(Mist.get("t-migrate-throws").state().warnings).toEqual([expect.stringMatching(/migration to 2 threw/)]);

    run.dispose();
    broken = false;
    ran.length = 0;
    definition.start!(fakeContext({ native: mistNative(false), schema: settings, settings: stored }).ctx);
    expect(ran).toEqual(["2", "3", "start"]);
    expect(stored[SETTINGS_VERSION]).toBe(3);
    expect(Mist.get("t-migrate-throws").state().warnings).toEqual([]);
});

test("define refuses migrations without a whole `to` of their own", () => {
    const mist = createMist("t-migrate-bad");
    expect(() => mist.define({ migrate: [{ to: 1, run() { } }, { to: 1, run() { } }] })).toThrow(/its own whole `to`/);
    expect(() => mist.define({ migrate: [{ to: 1.5, run() { } }] })).toThrow(/1\.5/);
    expect(() => mist.define({ migrate: [{ to: 0, run() { } }] })).toThrow(/not 0/);
});
