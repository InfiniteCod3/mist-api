import { expect, test } from "bun:test";

import { createDebug } from "../src/debug";
import { createRecorder } from "../src/recorder";
import { fakeContext, mistNative, type NativeImpl, noNative, plainNative } from "./helpers";

/** One plugin's debug views over a run whose native side is `native` */
async function setup(native: NativeImpl) {
    const recorder = createRecorder({ keepValues: true });
    const run = fakeContext(native, { volume: 70, apiToken: "do-not-show" });
    const callNative = (method: string, args: unknown[]) => recorder.track(method, args, async () => run.ctx.native.call(method, ...args));
    const debug = createDebug({
        id: "t-gate",
        recorder,
        exposed: new Map([["place", () => ({ city: "Berlin" })]]),
        context: () => run.ctx,
        startedAt: () => 0,
        callNative,
        provides: {},
        warnings: () => [],
    });
    await debug.probe(run.ctx);
    await callNative("echo", ["private text"]).catch(() => { });
    await callNative("missing", []).catch(() => { });
    recorder.log("info", ["private log text", { user: "private value" }]);
    return debug;
}

const echo = { echo: (s: string) => s };

for (const [name, native, refusal] of [
    ["no native side", noNative, /has no native module/],
    ["a native side without defineNative", plainNative(echo), /doesn't use defineNative/],
    ["main without a debugging port", mistNative(false, echo), /wasn't started with --remote-debugging-port/],
] as const) {
    test(`with ${name}, the capability refuses calls but shows the page's own records whole`, async () => {
        const { capability } = await setup(native);
        expect(capability.open()).toBe(false);
        await expect(capability.call("echo", "x")).rejects.toThrow(refusal);
        expect(capability.values()).toEqual({ place: { city: "Berlin" } });
        expect(capability.settings()).toEqual({ volume: 70, apiToken: "[secret]" });
        expect(capability.calls().map(c => c.args)).toEqual([["private text"], []]);
        expect(capability.calls()[1].outcome).toMatchObject({ state: "error", message: expect.stringMatching(/^(has no native module|no native method missing)$/) });
        expect(capability.logs().at(-1)!.args).toEqual(["private log text", { user: "private value" }]);
    });
}

test("with main's debugging port, the capability calls and shows values whole, secrets still masked", async () => {
    const { capability } = await setup(mistNative(true, echo));
    expect(capability.open()).toBe(true);
    expect(await capability.call("echo", "hello")).toBe("hello");
    expect(capability.values()).toEqual({ place: { city: "Berlin" } });
    expect(capability.settings()).toEqual({ volume: 70, apiToken: "[secret]" });
    expect(capability.calls().map(c => [c.method, c.args])).toEqual([["echo", ["private text"]], ["missing", []], ["echo", ["hello"]]]);
    expect(capability.calls()[1].outcome).toMatchObject({ state: "error", message: "no native method missing" });
    expect(capability.logs().at(-1)!.args).toEqual(["private log text", { user: "private value" }]);
});

test("the page-wide handle never calls and never shows values, even with the port open", async () => {
    const { handle } = await setup(mistNative(true, echo));
    expect(handle.state().debug).toBe(true);
    await expect(handle.call("echo", "x")).rejects.toThrow(/only CDP reaches/);
    expect<unknown>(handle.values()).toEqual({ place: "object(1 keys)" });
    expect(JSON.stringify(handle.calls())).not.toContain("private text");
    expect<unknown>(handle.settings()).toEqual({ volume: "number", apiToken: "string(8)" });
});

test("the page-wide handle reduces log text and error messages to type and size", async () => {
    const { handle } = await setup(mistNative(true, echo));
    expect<unknown>(handle.logs().at(-1)!.args).toEqual(["string(16)", "object(1 keys)"]);
    expect(handle.calls()[1].outcome).toMatchObject({ state: "error", message: "string(24)" });
    expect(JSON.stringify([handle.logs(), handle.calls()])).not.toContain("private");
    expect(JSON.stringify(handle.calls())).not.toContain("no native method");
});

test("the native side is asked once", async () => {
    let asked = 0;
    const native: NativeImpl = async method => {
        if (method === "__mist_debugAllowed") asked++;
        return true;
    };
    const debug = await setup(native);
    const run = fakeContext(native);
    await debug.probe(run.ctx);
    await debug.capability.call("anything");
    expect(asked).toBe(1);
});

test("a probe that fails is asked again, and only an answer is kept", async () => {
    let asked = 0;
    const native: NativeImpl = async (method, ...args) => {
        if (method === "__mist_debugAllowed" && ++asked === 1) throw new Error("main was busy");
        return mistNative(true, echo)(method, ...args);
    };
    const { handle, capability } = await setup(native);
    expect(handle.state().native).toBe("plain");
    expect(await capability.call("echo", "after")).toBe("after");
    expect(handle.state()).toMatchObject({ native: "mist", debug: true });
    await capability.call("echo", "again");
    expect(asked).toBe(2);
});

test("nothing page code can read from the handle leads to the capability", async () => {
    const { handle, capability } = await setup(mistNative(true));
    const reachable: unknown[] = [];
    for (let at: object | null = handle; at; at = Object.getPrototypeOf(at)) {
        for (const key of Reflect.ownKeys(at)) reachable.push(Reflect.get(at, key, handle));
    }
    expect(reachable).not.toContain(capability);
    expect(Object.isFrozen(handle) && Object.isFrozen(capability)).toBe(true);
});
