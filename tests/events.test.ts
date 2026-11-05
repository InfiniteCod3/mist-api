import type { NativeContext } from "@evi/api/native";
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";

import { createMist } from "../src/index";
import type { MistNative, NativeEventsOptions } from "../src/native";
import { fakeContext } from "../src/testing";
import { copyOfSources } from "./copies";


type Note = { type: "saved"; id: string; } | { type: "toast"; text: string; };

const copies: (() => void)[] = [];
afterAll(() => { for (const remove of copies) remove(); });

/** A native side made with defineNative and an event channel, in its own copy of mist-api as each native bundle has */
async function nativeWith(options: NativeEventsOptions<Note> = {}) {
    const copy = copyOfSources("0.0.1-events");
    copies.push(copy.remove);
    const fresh: typeof import("../src/native") = await import(join(copy.dir, "native.ts"));
    const events = fresh.nativeEvents<Note>(options);
    const module = fresh.defineNative({ ping() { return "pong"; } }, { events });
    const calls: string[] = [];
    /** Evi's IPC: start and stop aren't callable, and arguments and results are structured-cloned */
    const bridge = async (method: string, ...args: unknown[]) => {
        calls.push(method);
        const fn = (module as Record<string, unknown>)[method];
        if (typeof fn !== "function" || method === "start" || method === "stop") throw new Error(`no native method ${method}`);
        return structuredClone(await fn.apply(module, structuredClone(args)));
    };
    module.start({ pluginId: "t-events" } as NativeContext);
    return { events, module, bridge, calls };
}

const poll = (module: MistNative<{}, Note>, boot: string | null, cursor: number) => module.__mist_events(boot, cursor);

async function until(done: () => boolean, ms = 2000) {
    const end = Date.now() + ms;
    while (!done()) {
        if (Date.now() > end) throw new Error("timed out waiting");
        await new Promise(resolve => setTimeout(resolve, 2));
    }
}

/** A running plugin whose page subscribes to `native`'s channel */
function page(id: string, bridge: (method: string, ...args: unknown[]) => Promise<unknown>) {
    const mist = createMist<{}, MistNative<{ ping(): string; }, Note>>(id);
    const run = fakeContext({ native: bridge, id });
    mist.define({}).start!(run.ctx);
    return { mist, run };
}

test("events reach the page in push order, each once, and only after the page connected unless replayed", async () => {
    const { events, bridge } = await nativeWith({ waitMs: 20 });
    events.push({ type: "toast", text: "before" });
    const { mist } = page("t-events-order", bridge);
    const got: Note[] = [];
    let connected = 0;
    mist.events.subscribe(note => got.push(note), { onConnect: () => { connected++; } });
    await until(() => connected === 1);
    for (const id of ["a", "b", "c"]) events.push({ type: "saved", id });
    await until(() => got.length === 3);
    events.push({ type: "toast", text: "d" });
    await until(() => got.length === 4);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(got).toEqual([{ type: "saved", id: "a" }, { type: "saved", id: "b" }, { type: "saved", id: "c" }, { type: "toast", text: "d" }]);
    expect(connected).toBe(1);
});

test("a page that connects gets the replayed events from before, then everything after", async () => {
    const { events, module } = await nativeWith({ replay: e => e.type === "saved", waitMs: 0 });
    events.push({ type: "saved", id: "a" });
    events.push({ type: "toast", text: "gone" });
    events.push({ type: "saved", id: "b" });
    const first = await poll(module, null, 0);
    expect(first.fresh).toBe(true);
    expect(first.events).toEqual([{ type: "saved", id: "a" }, { type: "saved", id: "b" }]);
    events.push({ type: "toast", text: "now" });
    const next = await poll(module, first.boot, first.cursor);
    expect(next.fresh).toBe(false);
    expect(next.events).toEqual([{ type: "toast", text: "now" }]);
});

test("the log keeps the last `keep` events, and a page that fell behind them loads its state again", async () => {
    const { events, module } = await nativeWith({ keep: 3, replay: () => true, waitMs: 0 });
    const first = await poll(module, null, 0);
    for (let i = 1; i <= 5; i++) events.push({ type: "saved", id: String(i) });
    const behind = await poll(module, first.boot, first.cursor);
    expect(behind.fresh).toBe(true);
    expect(behind.events.map(e => e.type === "saved" && e.id)).toEqual(["3", "4", "5"]);
    // A page right at the edge of the kept log missed nothing
    const atEdge = await poll(module, behind.boot, 2);
    expect(atEdge.fresh).toBe(false);
    expect(atEdge.events.map(e => e.type === "saved" && e.id)).toEqual(["3", "4", "5"]);
});

test("live is checked when an event is handed out, so an event that stopped being true isn't delivered", async () => {
    const open = new Set(["a", "b"]);
    const { events, module } = await nativeWith({ replay: () => true, live: e => e.type !== "saved" || open.has(e.id), waitMs: 0 });
    const first = await poll(module, null, 0);
    events.push({ type: "saved", id: "a" });
    events.push({ type: "saved", id: "b" });
    open.delete("a");
    expect((await poll(module, first.boot, first.cursor)).events).toEqual([{ type: "saved", id: "b" }]);
    expect((await poll(module, null, 0)).events).toEqual([{ type: "saved", id: "b" }]);
});

test("a restart of the native side starts a new log under a new boot id, and the page runs onConnect again", async () => {
    const { events, module, bridge } = await nativeWith({ replay: e => e.type === "saved", waitMs: 20 });
    const { mist } = page("t-events-restart", bridge);
    const got: Note[] = [];
    let connected = 0;
    mist.events.subscribe(note => got.push(note), { onConnect: () => { connected++; }, retryMs: 5 });
    await until(() => connected === 1);
    const before = await poll(module, null, 0);

    module.stop();
    module.start({ pluginId: "t-events" } as NativeContext);
    events.push({ type: "saved", id: "after" });
    await until(() => connected === 2 && got.length === 1);
    expect(got).toEqual([{ type: "saved", id: "after" }]);
    const after = await poll(module, before.boot, before.cursor);
    expect(after.boot).not.toBe(before.boot);
    expect(after.fresh).toBe(true);
});

test("stop answers every waiting poll at once, and polls while stopped fail", async () => {
    const { module } = await nativeWith({ waitMs: 10_000 });
    const first = await poll(module, null, 0);
    const began = performance.now();
    const waiting = [poll(module, first.boot, first.cursor), poll(module, first.boot, first.cursor)];
    module.stop();
    const answers = await Promise.all(waiting);
    expect(performance.now() - began).toBeLessThan(1000);
    expect(answers.map(a => a.events)).toEqual([[], []]);
    await expect(poll(module, first.boot, first.cursor)).rejects.toThrow(/stopped/);
});

test("unsubscribing stops polling, and so does disposing the run", async () => {
    const { bridge, calls } = await nativeWith({ waitMs: 5 });
    const { mist, run } = page("t-events-off", bridge);
    const off = mist.events.subscribe(() => { });
    await until(() => calls.filter(m => m === "__mist_events").length >= 3);
    off();
    await new Promise(resolve => setTimeout(resolve, 20));
    const afterOff = calls.length;
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(calls.length).toBe(afterOff);

    mist.events.subscribe(() => { });
    await until(() => calls.length >= afterOff + 3);
    run.dispose();
    await new Promise(resolve => setTimeout(resolve, 20));
    const afterDispose = calls.length;
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(calls.length).toBe(afterDispose);
});

test("two subscribers each get every event, in order", async () => {
    const { events, bridge } = await nativeWith({ waitMs: 20 });
    const { mist } = page("t-events-two", bridge);
    const a: string[] = [];
    const b: string[] = [];
    let connected = 0;
    mist.events.subscribe(e => a.push(e.type === "saved" ? e.id : e.text), { onConnect: () => { connected++; } });
    mist.events.subscribe(e => b.push(e.type === "saved" ? e.id : e.text), { onConnect: () => { connected++; } });
    await until(() => connected === 2);
    for (const id of ["1", "2", "3"]) events.push({ type: "saved", id });
    await until(() => a.length === 3 && b.length === 3);
    expect(a).toEqual(["1", "2", "3"]);
    expect(b).toEqual(["1", "2", "3"]);
});

test("a failed onConnect is retried before any event is delivered, and a throwing listener doesn't stop the others", async () => {
    const { events, bridge } = await nativeWith({ replay: () => true, waitMs: 20 });
    events.push({ type: "saved", id: "early" });
    const { mist, run } = page("t-events-retry", bridge);
    const got: string[] = [];
    let attempts = 0;
    mist.events.subscribe(e => {
        if (e.type === "toast") throw new Error("listener broke");
        got.push(e.id);
    }, {
        onConnect: () => { if (++attempts < 3) throw new Error("not ready"); },
        retryMs: 5,
    });
    await until(() => got.length === 1);
    expect(attempts).toBe(3);
    events.push({ type: "toast", text: "x" });
    events.push({ type: "saved", id: "late" });
    await until(() => got.length === 2);
    expect(got).toEqual(["early", "late"]);
    const warned = run.logs.filter(p => p.level === "warn").map(p => p.args[0]);
    expect(warned).toEqual(["Couldn't get events from the native side; trying again", "An event listener threw"]);
});

test("the poll is counted, not kept, on both sides", async () => {
    const { module, bridge } = await nativeWith({ waitMs: 5 });
    const { mist } = page("t-events-quiet", bridge);
    const off = mist.events.subscribe(() => { });
    await new Promise(resolve => setTimeout(resolve, 40));
    off();
    const handle = (globalThis as any).Mist.get("t-events-quiet");
    expect(handle.calls()).toEqual([]);
    expect(handle.state().quiet.__mist_events).toBeGreaterThan(1);
    const native = module.__mist_logs(50, false);
    expect(native.calls).toEqual([]);
    expect(native.quiet?.__mist_events).toBeGreaterThan(1);
});

test("subscribe needs a running plugin, and the listener is typed from the native module", async () => {
    const mist = createMist<{}, MistNative<{}, Note>>("t-events-types");
    expect(() => mist.events.subscribe(() => { })).toThrow(/isn't running/);
    // @ts-expect-error a Note has no `missing` field
    void (() => mist.events.subscribe(note => note.missing));
    const none = createMist("t-events-none");
    // @ts-expect-error a plugin without a channel gets no events
    void (() => none.events.subscribe((note: Note) => note));
});
