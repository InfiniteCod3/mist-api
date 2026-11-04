import { afterEach, expect, test } from "bun:test";

import { createMist, MIST_VERSION } from "../src/index";
import { fakeContext, mistNative, settle } from "./helpers";

afterEach(() => {
    delete (globalThis as any).Evi;
    delete (globalThis as any).GLOBAL_ENV;
    delete (navigator as any).clipboard;
});

function page(clipboard?: (text: string) => Promise<void>) {
    (globalThis as any).Evi = {
        version: "3.3.0",
        plugins: { get: (id: string) => id === "t-report" ? { running: true, evaluated: true, error: "start failed once", manifest: { name: "Weather", version: "1.4.2" } } : undefined },
    };
    (globalThis as any).GLOBAL_ENV = { RELEASE_CHANNEL: "stable", SENTRY_TAGS: { buildId: "abc123" } };
    if (clipboard) Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboard }, configurable: true });
}

async function reporting() {
    type Native = { lookup(place: { city: string; }): { temperature: number; }; };
    const mist = createMist<{}, Native>("t-report");
    const run = fakeContext(mistNative(true, { lookup: () => ({ temperature: 21 }) }), { apiToken: "hidden-token" }, "t-report");
    mist.define({}).start!(run.ctx);
    await mist.native.lookup({ city: "Berlin" });
    mist.log.warn("forecast for Berlin is stale", { apiToken: "hidden-token" });
    await settle();
    return { mist, run };
}

test("the report names the versions and the plugin's status, and shows each recorded value only as its type and size", async () => {
    page();
    const { mist } = await reporting();
    const report = await mist.report();
    expect(report).toContain("Debug report for t-report 1.4.2");
    expect(report).toContain(`mist-api ${MIST_VERSION}, Evi 3.3.0, Discord stable build abc123`);
    expect(report).toContain("Running, native side: mist");
    expect(report).toContain("Start error: start failed once");
    expect(report).toMatch(/warn {2}string\(28\) object\(1 keys\)/);
    expect(report).toMatch(/lookup\(object\(1 keys\)\) ok \d+ms -> object\(1 keys\)/);
    expect(report).toContain("Native side's log, last 50:");
    for (const value of ["Berlin", "hidden-token", "stale", "21"]) expect(report).not.toContain(value);
});

test("copyReport copies the report with the Clipboard API and toasts that it did", async () => {
    let copied = "";
    page(async text => void (copied = text));
    const { mist, run } = await reporting();
    expect(await mist.copyReport()).toBe(true);
    expect(copied).toStartWith("Debug report for t-report 1.4.2");
    expect(run.toasts).toEqual(["Copied the debug report. Paste it into your bug report."]);
});

test("when the clipboard refuses and there's no document to fall back on, copyReport says so", async () => {
    page(() => Promise.reject(new Error("Document is not focused")));
    const { mist, run } = await reporting();
    expect(await mist.copyReport()).toBe(false);
    expect(run.toasts).toEqual(["Couldn't copy the debug report."]);
});

test("the report command copies the report, or shows it when copying fails", async () => {
    let copied = "";
    page(async text => void (copied = text));
    const { mist } = await reporting();
    const command = mist.reportCommand();
    expect(command.name).toBe("t-report-report");
    expect(await command.execute({}, {} as any)).toEqual({ ephemeral: "Copied the debug report. Paste it into your bug report." });
    expect(copied).toStartWith("Debug report for t-report");

    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("no")) }, configurable: true });
    const shown = await mist.reportCommand("weather-report").execute({}, {} as any) as { ephemeral: string; };
    expect(shown.ephemeral).toStartWith("Couldn't copy the debug report. Here it is:\n```\nDebug report for t-report 1.4.2");
});

test("a report needs no running plugin and no Evi", async () => {
    const mist = createMist("t-report-idle");
    mist.define({});
    const report = await mist.report();
    expect(report).toContain("Debug report for t-report-idle (version unknown)");
    expect(report).toContain("Evi unknown, Discord unknown");
    expect(report).toContain("Stopped, native side: unknown");
});
