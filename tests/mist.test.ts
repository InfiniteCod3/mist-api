import { expect, test } from "bun:test";

import { createMist } from "../src/index";
import { defineNative } from "../src/native";
import { fakeContext } from "../src/testing";
import { mistNative, settle } from "./helpers";

type Native = {
    add(a: number, b: number): number;
    fail(): Promise<void>;
    start(): void;
};

test("define keeps mist.ctx from start until the run is disposed, and runs the plugin's own start and stop", () => {
    const mist = createMist("t-define");
    const calls: string[] = [];
    const definition = mist.define({
        start(ctx) { calls.push(mist.ctx === ctx ? "start saw ctx" : "start without ctx"); },
        stop() { calls.push(mist.running ? "stop while running" : "stop after clear"); },
    });
    expect(mist.running).toBe(false);
    expect(() => mist.ctx).toThrow(/t-define isn't running/);

    const run = fakeContext({ native: mistNative(false) });
    definition.start!(run.ctx);
    expect(mist.running).toBe(true);
    expect(mist.ctx).toBe(run.ctx);

    // Evi calls stop, then runs the context's disposers
    definition.stop!(run.ctx);
    run.dispose();
    expect(mist.running).toBe(false);
    expect(() => mist.ctx).toThrow(/t-define/);
    expect(calls).toEqual(["start saw ctx", "stop while running"]);
});

test("a late dispose of an old run doesn't clear the newer run", () => {
    const mist = createMist("t-rerun");
    const definition = mist.define({});
    const first = fakeContext({ native: mistNative(false) });
    const second = fakeContext({ native: mistNative(false) });
    definition.start!(first.ctx);
    definition.start!(second.ctx);
    first.dispose();
    expect(mist.ctx).toBe(second.ctx);
});

test("mist.native calls the native side and records each call's outcome", async () => {
    const mist = createMist<{}, Native>("t-native");
    const definition = mist.define({});
    const run = fakeContext({ native: mistNative(true, {
        add: (a: number, b: number) => a + b,
        fail: () => { throw new Error("nope"); },
    }) });
    definition.start!(run.ctx);

    expect(await mist.native.add(2, 3)).toBe(5);
    await expect(mist.native.fail()).rejects.toThrow("nope");
    await settle();

    const handle = (globalThis as any).Mist.get("t-native");
    const calls = handle.calls();
    expect(calls.map((c: any) => [c.method, c.outcome.state])).toEqual([["add", "ok"], ["fail", "error"]]);
    expect(calls[1].outcome.message).toBe("string(4)");
    expect(typeof calls[0].outcome.ms).toBe("number");
    expect(handle.state().errors.calls).toBe(1);
});

type Channels = { add: [[a: number, b: number], number]; name: [[], string]; };
// Never called: defineNative runs once per bundle, and native.test.ts owns this one. Only its type is wanted.
const generic = () => defineNative({
    async invoke<C extends keyof Channels>(channel: C, args: Channels[C][0]): Promise<Channels[C][1]> {
        return (channel === "add" ? (args[0] as number) + (args[1] as number) : "mist") as Channels[C][1];
    },
    sync(n: number) { return n; },
});

test("a generic native method that returns a promise keeps its type parameters on mist.native", async () => {
    const mist = createMist<{}, ReturnType<typeof generic>>("t-generic");
    mist.define({}).start!(fakeContext({ native: mistNative(false, { invoke: (c: string, a: number[]) => c === "add" ? a[0] + a[1] : "mist", sync: (n: number) => n }) }).ctx);
    const sum: number = await mist.native.invoke("add", [1, 2]);
    const name: string = await mist.native.invoke("name", []);
    // @ts-expect-error add's arguments are numbers
    await mist.native.invoke("add", ["1", 2]);
    // @ts-expect-error name returns a string
    const wrong: number = await mist.native.invoke("name", []);
    const synced: Promise<number> = mist.native.sync(4);
    expect([sum, name, await synced]).toEqual([3, "mist", 4]);
    void wrong;
});

test("mist.native before start fails with the plugin's name and is recorded", async () => {
    const mist = createMist<{}, Native>("t-early");
    mist.define({});
    await expect(mist.native.add(1, 1)).rejects.toThrow(/t-early isn't running/);
});

test("mist.native is not a thenable", async () => {
    const mist = createMist<{}, Native>("t-then");
    expect((mist.native as any).then).toBeUndefined();
    expect(await Promise.resolve(mist.native)).toBe(mist.native);
});

test("mist.log prints through ctx.logger while running and keeps every line", () => {
    const mist = createMist("t-log");
    const definition = mist.define({});
    mist.log.info("before start");
    const run = fakeContext({ native: mistNative(false), id: "t-log" });
    definition.start!(run.ctx);
    mist.log.warn("while running", 1);
    expect(run.logs).toEqual([{ level: "warn", args: ["while running", 1] }]);
    const logs = (globalThis as any).Mist.get("t-log").logs();
    expect(logs.map((l: any) => [l.level, l.args[0]])).toEqual([["info", "string(12)"], ["warn", "string(13)"]]);
});

test("mist.log.log prints through ctx.logger.log and is kept at level log, as Vencord's Logger.log", () => {
    const mist = createMist("t-log-log");
    const run = fakeContext({ native: mistNative(false), id: "t-log-log" });
    mist.define({}).start!(run.ctx);
    mist.log.log("plain line");
    expect(run.logs).toEqual([{ level: "log", args: ["plain line"] }]);
    expect((globalThis as any).Mist.get("t-log-log").logs().map((l: any) => l.level)).toEqual(["log"]);
});

test("safe returns the fallback and logs each distinct error once", () => {
    const mist = createMist("t-safe");
    const definition = mist.define({});
    const run = fakeContext({ native: mistNative(false), id: "t-safe" });
    definition.start!(run.ctx);
    const parse = mist.safe((n: number) => {
        if (n < 0) throw new Error("negative");
        if (n === 0) throw new Error("zero");
        return n * 2;
    }, -1);

    expect(parse(2)).toBe(4);
    expect(parse(-5)).toBe(-1);
    expect(parse(-6)).toBe(-1);
    expect(parse(0)).toBe(-1);
    expect(run.logs.filter(p => p.level === "error")).toHaveLength(2);
});

test("warns when createMist's id isn't the id Evi runs the plugin as", () => {
    const mist = createMist("t-typo");
    const run = fakeContext({ native: mistNative(false), id: "t-real" });
    mist.define({}).start!(run.ctx);
    expect(run.logs).toEqual([{ level: "warn", args: [expect.stringContaining("Use the id from manifest.json")] }]);
    const quiet = fakeContext({ native: mistNative(false), id: "t-typo" });
    mist.define({}).start!(quiet.ctx);
    expect(quiet.logs).toEqual([]);
});

test("safe keeps `this` for patch callbacks", () => {
    const mist = createMist("t-safe-this");
    const self = { factor: 3, times: mist.safe(function (this: { factor: number; }, n: number) { return n * this.factor; }, 0) };
    expect(self.times(2)).toBe(6);
});

/** A started plugin, for safe's log lines */
function running(id: string) {
    const mist = createMist(id);
    const run = fakeContext({ native: mistNative(false), id });
    mist.define({}).start!(run.ctx);
    return { mist, errors: () => run.logs.filter(p => p.level === "error").map(p => p.args[0]) };
}

test("safe's fallback can be a function of the same arguments and `this`, as Discord's own value", () => {
    const { mist } = running("t-safe-fn");
    const lineText = mist.safe(function (this: { suffix: string; }, line: { text?: string; }) {
        return line.text!.trim() + this.suffix;
    }, function (this: { suffix: string; }, line) { return `${line.text ?? "(none)"}${this.suffix}`; });
    const self = { suffix: "!", lineText };
    expect(self.lineText({ text: " hi " })).toBe("hi!");
    expect(self.lineText({})).toBe("(none)!");
});

test("safe logs the plugin's own message in place of the default line", () => {
    const { mist, errors } = running("t-safe-message");
    const render = mist.safe(() => { throw new Error("boom"); }, null, { message: "Couldn't draw the forecast row" });
    expect(render()).toBeNull();
    expect(errors()).toEqual(["Couldn't draw the forecast row"]);
});

test("a fallback function that throws too is logged, and the wrapper still doesn't throw", () => {
    const { mist, errors } = running("t-safe-both");
    const both = mist.safe((n: number): number => { throw new Error(`fn ${n}`); }, n => { throw new Error(`fallback ${n}`); });
    expect(both(1)).toBeUndefined();
    expect(errors()).toEqual([expect.stringContaining("threw; returning its fallback"), expect.stringContaining("fallback threw")]);
});

/** A native side whose __mist_protocol answers with each of `answers` in turn, the last one from then on */
function probed(answers: (number | Error)[]) {
    const seen = { probes: 0, marked: [] as boolean[] };
    const native = async (method: string, ...args: unknown[]) => {
        if (method === "__mist_debugAllowed") return false;
        if (method === "__mist_protocol") {
            const answer = answers[Math.min(seen.probes++, answers.length - 1)];
            if (answer instanceof Error) throw answer;
            return answer;
        }
        const mark = (args.at(-1) as { __mist_call?: number; } | undefined)?.__mist_call === 1;
        seen.marked.push(mark);
        return mark ? { __mist_answer: 1, ok: true, value: 5 } : 5;
    };
    return { seen, native };
}

test("a protocol probe that fails for no known reason is asked again at the next call; a definite answer is kept for the run", async () => {
    const busy = probed([new Error("Error invoking remote method 'evi:plugin-native-call': Error: main is busy"), 1]);
    const mist = createMist<{}, Native>("t-probe-busy");
    mist.define({}).start!(fakeContext({ native: busy.native }).ctx);
    for (let i = 0; i < 3; i++) expect(await mist.native.add(2, 3)).toBe(5);
    expect(busy.seen).toEqual({ probes: 2, marked: [false, true, true] });

    const plain = probed([new Error("Error invoking remote method 'evi:plugin-native-call': Error: Plugin t-probe-plain has no native method __mist_protocol")]);
    const other = createMist<{}, Native>("t-probe-plain");
    other.define({}).start!(fakeContext({ native: plain.native }).ctx);
    for (let i = 0; i < 3; i++) expect(await other.native.add(2, 3)).toBe(5);
    expect(plain.seen).toEqual({ probes: 1, marked: [false, false, false] });
});
