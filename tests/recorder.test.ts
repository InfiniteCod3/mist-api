import { expect, test } from "bun:test";

import { createMist } from "../src/index";
import { createRecorder } from "../src/recorder";
import { fakeContext, mistNative, settle } from "./helpers";

test("secretArgs masks a method's positional arguments in every view, and leaves an empty one as it is", async () => {
    for (const keepValues of [true, false]) {
        const recorder = createRecorder({ keepValues, secretArgs: { login: [1] } });
        recorder.track("login", ["ada", "one-time-code", 5], () => true);
        recorder.track("login", ["ada", "", 5], () => true);
        recorder.track("other", ["ada", "one-time-code"], () => true);
        const whole = recorder.calls(undefined, keepValues);
        expect(JSON.stringify(recorder.calls(undefined, false).slice(0, 2))).not.toContain("string(13)");
        if (keepValues) {
            expect<unknown>(whole.map(c => c.args)).toEqual([
                ["ada", "[secret]", 5],
                ["ada", "", 5],
                ["ada", "one-time-code"],
            ]);
        }
        expect(JSON.stringify(recorder.calls(undefined, keepValues).slice(0, 2))).not.toContain("one-time-code");
    }
});

type Auth = { login(user: string, code: string, attempt: number): Promise<boolean>; };

test("createMist's secretArgs masks the page's record of the call, and names only the native side's methods", async () => {
    const mist = createMist<{}, Auth>("t-secret-args", { secretArgs: { login: [1] } });
    mist.define({}).start!(fakeContext(mistNative(false, { login: () => true }), {}, "t-secret-args").ctx);
    expect(await mist.native.login("ada", "one-time-code", 5)).toBe(true);
    await settle();
    const handle = (globalThis as any).Mist.get("t-secret-args");
    expect(handle.calls()[0].args).toEqual(["string(3)", "string(8)", "number"]);
    // @ts-expect-error secretArgs names the native side's methods
    createMist<{}, Auth>("t-secret-args-typo", { secretArgs: { logn: [1] } });
});

test("reveal reaches the recorder: a revealed name shows in calls and values, other built-in names stay masked", () => {
    const recorder = createRecorder({ keepValues: true, reveal: ["sessionId"] });
    recorder.track("history", [{ sessionId: "4f7c", accessToken: "t" }], () => ({ usage: { input_tokens: 5 } }));
    const [call] = recorder.calls(undefined, true);
    expect<unknown>(call.args).toEqual([{ sessionId: "4f7c", accessToken: "[secret]" }]);
    expect<unknown>(call.outcome).toMatchObject({ state: "ok", result: { usage: { input_tokens: 5 } } });
    expect(recorder.snapshot({ sessionId: "4f7c" })).toEqual({ sessionId: "4f7c" });
});

test("quiet methods are counted, not kept, so a long poll doesn't fill the ring; a failed one is still kept", async () => {
    const recorder = createRecorder({ keepValues: true, capacity: 3, quiet: ["poll"] });
    for (let i = 0; i < 10; i++) await recorder.track("poll", [i], async () => ({ cursor: i }));
    recorder.track("send", ["hi"], () => true);
    await recorder.track("poll", [10], async () => { throw new Error("main restarted"); }).catch(() => { });
    expect(recorder.calls(undefined, true).map(c => [c.method, c.outcome.state])).toEqual([["send", "ok"], ["poll", "error"]]);
    expect(recorder.quiet()).toEqual({ poll: 11 });
    expect(recorder.errors().calls).toBe(1);
});

test("createMist's quiet counts show in the plugin's state, and name only the native side's methods", async () => {
    type Desk = { poll(cursor: number): Promise<number>; send(text: string): Promise<void>; };
    const mist = createMist<{}, Desk>("t-quiet", { quiet: ["poll"] });
    mist.define({}).start!(fakeContext(mistNative(false, { poll: (n: number) => n + 1 }), {}, "t-quiet").ctx);
    await mist.native.poll(0);
    await mist.native.poll(1);
    const handle = (globalThis as any).Mist.get("t-quiet");
    expect(handle.calls()).toEqual([]);
    expect(handle.state().quiet).toEqual({ poll: 2 });
    // @ts-expect-error quiet names the native side's methods
    createMist<{}, Desk>("t-quiet-typo", { quiet: ["pol"] });
});
