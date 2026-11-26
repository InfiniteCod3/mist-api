import { expect, test } from "bun:test";
import * as React from "react";
import { act, create } from "react-test-renderer";

import { createMist } from "../src/index";
import { defineNative } from "../src/native";
import { fakeContext, fakeEvi } from "../src/testing";
import { mistNative, settle } from "./helpers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

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

test("mist.log.log prints through ctx.logger.log and is kept at level log", () => {
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

const schema = {
    compact: { type: "boolean", label: "Compact", default: false },
    size: { type: "number", label: "Size", default: 12 },
} as const;

test("mist.settings reads the schema's defaults between runs, the stored values while running, and ignores writes while stopped", () => {
    const mist = createMist<typeof schema>("t-settings");
    const definition = mist.define({ settings: schema });
    expect(mist.settings.get("size")).toBe(12);
    expect(mist.settings.all()).toEqual({ compact: false, size: 12 });
    mist.settings.set("size", 20);
    expect(mist.settings.get("size")).toBe(12);

    const run = fakeContext({ id: "t-settings", schema, settings: { size: 16 } });
    definition.start!(run.ctx);
    expect(mist.settings.get("size")).toBe(16);
    mist.settings.set("compact", true);
    expect(run.ctx.settings.get("compact")).toBe(true);
    expect(mist.settings.all()).toEqual({ compact: true, size: 16 });

    run.dispose();
    expect(mist.settings.get("compact")).toBe(false);
});

test("mist.settings.onChange hears changes in every run and the switch to defaults at stop, until it is removed", () => {
    const mist = createMist<typeof schema>("t-settings-change");
    const definition = mist.define({ settings: schema });
    const heard: number[] = [];
    const off = mist.settings.onChange(values => heard.push(values.size));

    const first = fakeContext({ id: "t-settings-change", schema, settings: { size: 14 } });
    definition.start!(first.ctx);
    first.ctx.settings.set("size", 15);
    first.ctx.settings.set("size", 15);
    first.dispose();
    const second = fakeContext({ id: "t-settings-change", schema });
    definition.start!(second.ctx);
    second.ctx.settings.set("size", 30);
    off();
    second.ctx.settings.set("size", 31);
    expect(heard).toEqual([14, 15, 12, 30]);
});

test("mist.settings is a ChangeSource, for useStore", () => {
    const mist = createMist<typeof schema>("t-settings-source");
    const definition = mist.define({ settings: schema });
    const run = fakeContext({ id: "t-settings-source", schema });
    definition.start!(run.ctx);
    let changes = 0;
    const listener = () => void changes++;
    mist.settings.addChangeListener(listener);
    run.ctx.settings.set("compact", true);
    mist.settings.removeChangeListener(listener);
    run.ctx.settings.set("compact", false);
    expect(changes).toBe(1);
});

test("mist.settings.use re-renders when its key changes, not for other keys, and shows the default once stopped", () => {
    const mist = createMist<typeof schema>("t-settings-use");
    const definition = mist.define({ settings: schema });
    const run = fakeContext({ id: "t-settings-use", schema, settings: { size: 18 }, evi: fakeEvi({ React }) });
    definition.start!(run.ctx);
    let renders = 0;
    function Size() {
        renders++;
        return React.createElement("span", null, String(mist.settings.use("size")));
    }
    let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(Size)); });
    expect(root.toJSON()).toMatchObject({ children: ["18"] });
    act(() => run.ctx.settings.set("compact", true));
    expect(renders).toBe(1);
    act(() => run.ctx.settings.set("size", 19));
    expect(root.toJSON()).toMatchObject({ children: ["19"] });
    act(() => run.dispose());
    expect(root.toJSON()).toMatchObject({ children: ["12"] });
    act(() => root.unmount());
});

test("mist.data keeps a typed value with the settings, reads `initial` between runs, and tells subscribers of changes", () => {
    const mist = createMist("t-data");
    const definition = mist.define({});
    const pinned = mist.data<string[]>("pinned", []);
    pinned.set(["ignored"]);
    expect(pinned.get()).toEqual([]);

    const run = fakeContext({ id: "t-data" });
    definition.start!(run.ctx);
    const heard: string[][] = [];
    const off = pinned.onChange(value => heard.push(value));
    pinned.update(list => [...list, "a"]);
    expect(mist.data<string[]>("pinned", []).get()).toEqual(["a"]);
    expect(run.ctx.settings.all).toMatchObject({ "__mist_data:pinned": ["a"] });
    run.dispose();
    expect(pinned.get()).toEqual([]);
    off();
    expect(heard).toEqual([["a"], []]);
});

test("mist.data.use re-renders with the value", () => {
    const mist = createMist("t-data-use");
    const definition = mist.define({});
    const count = mist.data("count", 0);
    const run = fakeContext({ id: "t-data-use", evi: fakeEvi({ React }) });
    definition.start!(run.ctx);
    const Count = () => React.createElement("span", null, String(count.use()));
    let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(Count)); });
    act(() => count.update(n => n + 1));
    expect(root.toJSON()).toMatchObject({ children: ["1"] });
    act(() => root.unmount());
});

/** A started plugin with Flux */
function withFlux(id: string) {
    const mist = createMist(id);
    const evi = fakeEvi();
    const run = fakeContext({ id, evi });
    mist.define({}).start!(run.ctx);
    return { mist, run, dispatch: (action: { type: string; [key: string]: unknown; }) => void evi.module.Dispatcher.dispatch(action) };
}

test("mist.flux.on takes one type or several, ends when its function is called or the run stops, and does nothing between runs", () => {
    const { mist, run, dispatch } = withFlux("t-flux-on");
    const seen: string[] = [];
    const off = mist.flux.on(["A", "B"], action => seen.push(action.type));
    const one = mist.flux.on("C", action => seen.push(action.type));
    dispatch({ type: "A" });
    dispatch({ type: "C" });
    off();
    dispatch({ type: "B" });
    run.dispose();
    dispatch({ type: "C" });
    expect(seen).toEqual(["A", "C"]);
    one();
    expect(mist.flux.on("A", () => seen.push("late"))).toBeFunction();
    dispatch({ type: "A" });
    expect(seen).toEqual(["A", "C"]);
});

test("mist.flux.next resolves with the first matching action and stops listening", async () => {
    const { mist, dispatch } = withFlux("t-flux-next");
    const next = mist.flux.next<{ type: string; id: number; }>("LOADED", { where: action => action.id === 2 });
    dispatch({ type: "LOADED", id: 1 });
    dispatch({ type: "LOADED", id: 2 });
    expect(await next).toEqual({ type: "LOADED", id: 2 });
    let later = 0;
    mist.flux.on("LOADED", () => void later++);
    dispatch({ type: "LOADED", id: 2 });
    expect(later).toBe(1);
});

test("mist.flux.next rejects on timeout, on its signal, when the run stops, and at once between runs", async () => {
    const { mist, run } = withFlux("t-flux-next-reject");
    expect(await mist.flux.next("NEVER", { timeout: 5 }).catch(err => err.name)).toBe("TimeoutError");
    const controller = new AbortController();
    const aborted = mist.flux.next("NEVER", { signal: controller.signal }).catch(err => err);
    controller.abort(new Error("gave up"));
    expect((await aborted).message).toBe("gave up");
    const stopping = mist.flux.next("NEVER", { timeout: 1000 }).catch(err => err.message);
    run.dispose();
    expect(await stopping).toBe("t-flux-next-reject stopped");
    expect(await mist.flux.next("NEVER").catch(err => err.name)).toBe("AbortError");
});

test("pluginOf takes the mist object right after createMist, before define", async () => {
    const { pluginOf } = await import("../src/permissions");
    const mist = createMist("t-owner-early");
    expect(pluginOf(mist, "test")).toBe("t-owner-early");
    expect(() => pluginOf({ id: "t-owner-early" }, "test")).toThrow(TypeError);
});

test("subscribing and unsubscribing many times leaves no disposers behind in the run", async () => {
    const mist = createMist<{}, { [k: string]: never; }>("t-events-disposers");
    const run = fakeContext({ id: "t-events-disposers", native: async () => new Promise(() => { }) });
    const disposers: unknown[] = [];
    const onDispose = run.ctx.onDispose;
    run.ctx.onDispose = (fn: () => void) => (disposers.push(fn), onDispose(fn));
    mist.define({}).start!(run.ctx);
    const before = disposers.length;
    const events = mist.events as { subscribe(listener: (event: unknown) => void): () => void; };
    for (let i = 0; i < 20; i++) events.subscribe(() => { })();
    expect(disposers.length - before).toBeLessThanOrEqual(1);
});

test("a poll that fails because the native side has no channel method stops instead of retrying", async () => {
    let polls = 0;
    const mist = createMist("t-events-missing");
    const run = fakeContext({
        id: "t-events-missing",
        native: async method => {
            if (method === "__mist_events") polls++;
            throw new Error(`Error invoking remote method 'evi:plugin-native-call': Error: Plugin t-events-missing has no native method ${method}`);
        },
    });
    mist.define({}).start!(run.ctx);
    (mist.events as { subscribe(listener: (event: unknown) => void, options?: { retryMs?: number; }): () => void; }).subscribe(() => { }, { retryMs: 1 });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(polls).toBe(1);
    expect(run.logs.map(p => p.args[0])).toContain("The native side has no event channel; stopped listening");
});

test("failed polls wait longer each time in a row", async () => {
    const at: number[] = [];
    const mist = createMist("t-events-backoff");
    const run = fakeContext({
        id: "t-events-backoff",
        native: async () => {
            at.push(performance.now());
            throw new Error("main is busy");
        },
    });
    mist.define({}).start!(run.ctx);
    (mist.events as { subscribe(listener: (event: unknown) => void, options?: { retryMs?: number; }): () => void; }).subscribe(() => { }, { retryMs: 10 });
    await new Promise(resolve => setTimeout(resolve, 120));
    run.dispose();
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    expect(gaps.length).toBeLessThan(6);
    expect(gaps[1]).toBeGreaterThan(gaps[0]);
});

/** The page's request handling over `protocol` answers, with a poll that never answers */
async function requestsWith(protocol: () => Promise<number | undefined>) {
    const { createRequests } = await import("../src/replies");
    const run = fakeContext({ id: "t-requests-protocol" });
    const polls: number[] = [];
    const reports: string[] = [];
    const requests = createRequests<{ ping(payload: null): boolean; }>({
        context: () => run.ctx,
        protocol,
        poll: () => (polls.push(1), new Promise(() => { })),
        report: line => void reports.push(line),
        retryMs: 2,
    });
    requests.handle("ping", () => true);
    return { run, polls, reports };
}

test("mist.requests asks again for the protocol after a transient failure, and listens once the native side answers", async () => {
    let asked = 0;
    const { run, polls, reports } = await requestsWith(async () => ++asked < 3 ? undefined : 1);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(asked).toBe(3);
    expect(polls).toHaveLength(1);
    expect(reports).toEqual([]);
    run.dispose();
});

test("mist.requests stops, saying why once, when the native side definitely has no protocol, and stops asking when the run ends", async () => {
    const definite = await requestsWith(async () => 0);
    await settle();
    expect(definite.polls).toEqual([]);
    expect(definite.reports).toEqual([expect.stringContaining("has no __mist_protocol")]);

    let asked = 0;
    const transient = await requestsWith(async () => (asked++, undefined));
    await new Promise(resolve => setTimeout(resolve, 20));
    transient.run.dispose();
    const atDispose = asked;
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(asked).toBe(atDispose);
    expect(transient.reports).toEqual([]);
});

test("mist.data stores a JSON copy: later changes to the object aren't stored, and a value JSON can't hold throws", () => {
    const mist = createMist("t-data-json");
    const definition = mist.define({});
    const run = fakeContext({ id: "t-data-json" });
    definition.start(run.ctx);
    const prefs = mist.data<{ tags: string[]; }>("prefs", { tags: [] });
    const heard: unknown[] = [];
    prefs.onChange(value => heard.push(value));
    const mine = { tags: ["a"] };
    prefs.set(mine);
    mine.tags.push("b");
    expect(prefs.get()).toEqual({ tags: ["a"] });
    expect(prefs.get()).not.toBe(mine);
    prefs.set({ tags: ["a"] });
    expect(heard).toEqual([{ tags: ["a"] }]);
    expect(() => prefs.set(undefined as never)).toThrow(TypeError);
    const cycle: { tags: string[]; self?: unknown; } = { tags: [] };
    cycle.self = cycle;
    expect(() => prefs.set(cycle)).toThrow(/mist.data: "prefs" can't be stored as JSON/);
    expect(prefs.get()).toEqual({ tags: ["a"] });
    run.dispose();
});

test("mist.data: a value read, changed in place and set again is saved and heard, since a read is a copy", () => {
    const mist = createMist("t-data-in-place");
    const definition = mist.define({});
    const run = fakeContext({ id: "t-data-in-place", evi: fakeEvi({ React }) });
    definition.start(run.ctx);
    const pinned = mist.data<string[]>("pinned", []);
    pinned.set(["a"]);
    const heard: string[][] = [];
    pinned.onChange(value => heard.push(value));

    const list = pinned.get();
    list.push("b");
    // Changing what get() gave changes neither what's stored nor the next read
    expect(pinned.get()).toEqual(["a"]);
    expect(run.ctx.settings.all).toMatchObject({ "__mist_data:pinned": ["a"] });
    pinned.set(list);
    expect(pinned.get()).toEqual(["a", "b"]);
    expect(run.ctx.settings.all).toMatchObject({ "__mist_data:pinned": ["a", "b"] });
    expect(heard).toEqual([["a", "b"]]);

    pinned.update(current => {
        current.push("c");
        return current;
    });
    expect(pinned.get()).toEqual(["a", "b", "c"]);
    expect(heard).toEqual([["a", "b"], ["a", "b", "c"]]);
    // A listener's value is a copy too
    heard[1]!.push("x");
    expect(pinned.get()).toEqual(["a", "b", "c"]);

    // use() keeps one object between changes, so React renders once per change, not without end
    let renders = 0;
    const seen: string[][] = [];
    const List = () => {
        renders++;
        const value = pinned.use();
        seen.push(value);
        return React.createElement("span", null, value.join(","));
    };
    let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(List)); });
    expect(root.toJSON()).toMatchObject({ children: ["a,b,c"] });
    const afterMount = renders;
    act(() => pinned.update(current => {
        current.push("d");
        return current;
    }));
    expect(root.toJSON()).toMatchObject({ children: ["a,b,c,d"] });
    expect(renders - afterMount).toBe(1);
    // An equal value stores nothing and renders nothing
    act(() => pinned.set(["a", "b", "c", "d"]));
    expect(renders - afterMount).toBe(1);
    // A render for another reason gets the same object
    act(() => root.update(React.createElement(List)));
    expect(seen.at(-1)).toBe(seen.at(-2)!);
    act(() => root.unmount());
    run.dispose();
});

test("mist.data's initial value is copied on each read too", () => {
    const mist = createMist("t-data-initial-copy");
    const definition = mist.define({});
    const run = fakeContext({ id: "t-data-initial-copy" });
    definition.start(run.ctx);
    const tags = mist.data<string[]>("tags", []);
    tags.get().push("x");
    expect(tags.get()).toEqual([]);
    run.dispose();
});

test("mist.data's parse turns an older stored shape into the current one, once per stored value", () => {
    const mist = createMist("t-data-parse");
    const definition = mist.define({});
    const run = fakeContext({ id: "t-data-parse" });
    definition.start(run.ctx);
    (run.ctx.settings as { set(key: string, value: unknown): void; }).set("__mist_data:volume", 7);
    let parses = 0;
    const volume = mist.data("volume", { level: 50 }, {
        parse: raw => (parses++, typeof raw === "number" ? { level: raw } : raw as { level: number; }),
    });
    expect(volume.get()).toEqual({ level: 7 });
    expect(volume.get()).toBe(volume.get());
    expect(parses).toBe(1);
    const broken = mist.data("volume", { level: 50 }, { parse: () => { throw new Error("unknown shape"); } });
    expect(broken.get()).toEqual({ level: 50 });
    expect(run.logs.some(l => l.level === "error" && String(l.args[0]).includes("parse threw"))).toBe(true);
    run.dispose();
});

test("mist.data is a ChangeSource: stores' subscribe follows it", async () => {
    const { subscribe } = await import("../src/stores");
    const mist = createMist("t-data-source");
    const definition = mist.define({});
    const run = fakeContext({ id: "t-data-source" });
    definition.start(run.ctx);
    const count = mist.data("count", 0);
    let changes = 0;
    const off = subscribe([count], () => void changes++);
    count.set(1);
    expect(changes).toBeGreaterThan(0);
    off();
    const before = changes;
    count.set(2);
    expect(changes).toBe(before);
    run.dispose();
});

test("writes and Flux subscriptions between runs do nothing and log one debug line each", async () => {
    const { registry } = await import("../src/registry");
    const mist = createMist<{ size: { type: "number"; label: string; default: number; }; }>("t-idle");
    mist.define({ settings: { size: { type: "number", label: "Size", default: 1 } } });
    mist.settings.set("size", 2);
    mist.settings.set("size", 3);
    mist.flux.on("A", () => { })();
    mist.data("d", 0).set(1);
    expect(mist.settings.get("size")).toBe(1);
    const debugLines = registry().get("t-idle")!.logs().filter(l => l.level === "debug");
    expect(debugLines).toHaveLength(3);
});

test("mist.flux.next leaves no abort listener on mist.signal when subscribing throws", async () => {
    const { mist, run } = withFlux("t-flux-next-throws");
    (run.ctx as { flux: unknown; }).flux = { subscribe() { throw new Error("can't read messages"); } };
    const signal = mist.signal;
    let added = 0;
    const add = signal.addEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof add>) => (added++, add(...args))) as typeof add;
    await expect(mist.flux.next("MESSAGE_CREATE")).rejects.toThrow("can't read messages");
    expect(added).toBe(0);
    run.dispose();
});

test("mist.flux.on is typed by its action", () => {
    const { mist, run, dispatch } = withFlux("t-flux-typed");
    const ids: number[] = [];
    mist.flux.on<{ type: "LOADED"; id: number; }>("LOADED", action => void ids.push(action.id));
    dispatch({ type: "LOADED", id: 4 });
    expect(ids).toEqual([4]);
    run.dispose();
});
