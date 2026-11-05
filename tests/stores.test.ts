import { expect, mock, test } from "bun:test";
import * as React from "react";
import { act, create } from "react-test-renderer";

import type { ChangeSource } from "../src/stores";
import { fakeEvi, fakeStore } from "../src/testing";

const evi = fakeEvi({ React });
mock.module("@evi/api", () => evi.module);
const { currentUserId, isStreamerMode, stores, subscribe, useStore } = await import("../src/stores");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

test("re-renders when the store changes, and stops listening on unmount", () => {
    const store = fakeStore({ name: "a" });
    let renders = 0;
    function Name() {
        renders++;
        return React.createElement("span", null, useStore(store, () => store.name));
    }
    let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(Name)); });
    expect(root.toJSON()).toMatchObject({ children: ["a"] });

    act(() => store.change({ name: "b" }));
    expect(root.toJSON()).toMatchObject({ children: ["b"] });

    act(() => root.unmount());
    expect(store.listeners.size).toBe(0);
    expect(renders).toBeGreaterThanOrEqual(2);
});

test("a getter that builds a new array each time renders once per change, not forever", () => {
    const store = fakeStore({ ids: ["1", "2"] });
    let renders = 0;
    function Ids() {
        renders++;
        const ids = useStore(store, () => store.ids.map(id => `#${id}`));
        return React.createElement("span", null, ids.join(","));
    }
    let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(Ids)); });
    const afterMount = renders;
    act(() => store.change({ ids: ["3"] }));
    expect(root.toJSON()).toMatchObject({ children: ["#3"] });
    expect(renders - afterMount).toBe(1);
    act(() => root.unmount());
});

test("deps rebuild the value when what the getter reads besides the store changes", () => {
    const store = fakeStore({ users: { a: "Ann", b: "Bob" } as Record<string, string> });
    function User({ id }: { id: string; }) {
        return React.createElement("span", null, useStore(store, () => ({ name: store.users[id] }), [id]).name);
    }
    let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(User, { id: "a" })); });
    act(() => root.update(React.createElement(User, { id: "b" })));
    expect(root.toJSON()).toMatchObject({ children: ["Bob"] });
    act(() => root.unmount());
});

test("listens to every store in a list, and to a store that shows up later", () => {
    const a = fakeStore({ n: 1 });
    const b = fakeStore({ n: 10 });
    let late: typeof b | undefined;
    function Sum() {
        return React.createElement("span", null, String(useStore([a, late], () => a.n + (late?.n ?? 0))));
    }
    let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(Sum)); });
    expect(root.toJSON()).toMatchObject({ children: ["1"] });
    late = b;
    act(() => a.change({ n: 2 }));
    expect(root.toJSON()).toMatchObject({ children: ["12"] });
    act(() => b.change({ n: 20 }));
    expect(root.toJSON()).toMatchObject({ children: ["22"] });
    act(() => root.unmount());
    expect(a.listeners.size + b.listeners.size).toBe(0);
});

test("store getters look the store up when read", () => {
    expect(stores.user).toBeUndefined();
    expect(currentUserId()).toBeUndefined();
    evi.addStore("UserStore", { getCurrentUser: () => ({ id: "42" }) });
    expect(currentUserId()).toBe("42");
});

test("a UserStore without getCurrentUser gives no id, and the type makes callers check", () => {
    evi.addStore("UserStore", {});
    expect(currentUserId()).toBeUndefined();
    // @ts-expect-error getCurrentUser may be missing: call it with ?.()
    expect(() => stores.user!.getCurrentUser()).toThrow();
});

test("store getters and currentUserId give undefined while webpack isn't ready, and look again next time", () => {
    evi.addStore("UserStore", { getCurrentUser: () => ({ id: "7" }) });
    evi.ready = false;
    expect(stores.user).toBeUndefined();
    expect(currentUserId()).toBeUndefined();
    evi.ready = true;
    expect(currentUserId()).toBe("7");
});

test("presence and sessions are evi.lookups up by Discord's store names", () => {
    const presence = { getClientStatus: () => ({ desktop: "online" }) };
    evi.addStore("PresenceStore", presence);
    evi.lookups.length = 0;
    expect(stores.presence).toBe(presence as never);
    expect(stores.sessions).toBeUndefined();
    expect(evi.lookups).toEqual(["PresenceStore", "SessionsStore"]);
});

test("streamerMode is Discord's StreamerModeStore, and isStreamerMode reads each shape Discord builds have had", () => {
    evi.removeStore("StreamerModeStore");
    expect(isStreamerMode()).toBe(false);
    const getter = { enabled: true };
    evi.addStore("StreamerModeStore", getter);
    evi.lookups.length = 0;
    expect(stores.streamerMode).toBe(getter as never);
    expect(evi.lookups).toEqual(["StreamerModeStore"]);
    expect(isStreamerMode()).toBe(true);
    evi.addStore("StreamerModeStore", { isEnabled: () => true });
    expect(isStreamerMode()).toBe(true);
    evi.addStore("StreamerModeStore", { getState: () => ({ enabled: true }) });
    expect(isStreamerMode()).toBe(true);
    evi.addStore("StreamerModeStore", { enabled: false, isEnabled: () => false, getState: () => ({}) });
    expect(isStreamerMode()).toBe(false);
    evi.ready = false;
    expect(isStreamerMode()).toBe(false);
    evi.ready = true;
});

test("subscribe calls the listener on each store's change until unsubscribed", () => {
    const a = fakeStore({});
    const b = fakeStore({});
    let heard = 0;
    const unsubscribe = subscribe([a, undefined, b], () => heard++);
    a.change({});
    b.change({});
    expect(heard).toBe(2);
    unsubscribe();
    unsubscribe();
    a.change({});
    expect(heard).toBe(2);
    expect(a.listeners.size + b.listeners.size).toBe(0);
});

test("the same listener subscribed twice unsubscribes each subscription on its own", () => {
    const store = fakeStore({});
    let heard = 0;
    const listener = () => heard++;
    const first = subscribe(store, listener);
    subscribe(store, listener);
    first();
    store.change({});
    expect(heard).toBe(1);
});

test("a store named before Discord makes it is listened to once it exists, and the listener hears that it arrived", () => {
    let heard = 0;
    const unsubscribe = subscribe(["TLateStore"], () => heard++);
    expect(heard).toBe(0);
    const late = fakeStore({});
    evi.addStore("TLateStore", late);
    expect(heard).toBe(1);
    late.change({});
    expect(heard).toBe(2);
    unsubscribe();
    late.change({});
    expect(heard).toBe(2);
    expect(late.listeners.size).toBe(0);
});

test("a store named that already exists is listened to at once, without an extra call", () => {
    const store = fakeStore({});
    evi.addStore("TReadyStore", store);
    let heard = 0;
    const unsubscribe = subscribe("TReadyStore", () => heard++);
    expect(heard).toBe(0);
    store.change({});
    expect(heard).toBe(1);
    unsubscribe();
    expect(store.listeners.size).toBe(0);
});

test("unsubscribing before a named store exists stops the wait", () => {
    let heard = 0;
    subscribe("TNeverStore", () => heard++)();
    const store = fakeStore({});
    evi.addStore("TNeverStore", store);
    store.change({});
    expect(heard).toBe(0);
    expect(store.listeners.size).toBe(0);
});

test("useStore re-renders when a store it names arrives", () => {
    function Name() {
        const name = useStore("TNamedStore", () => (evi.module.findStore("TNamedStore") as { name?: string; } | undefined)?.name ?? "none");
        return React.createElement("span", null, name);
    }
    let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(Name)); });
    expect(root.toJSON()).toMatchObject({ children: ["none"] });
    const store = fakeStore({ name: "here" });
    act(() => evi.addStore("TNamedStore", store));
    expect(root.toJSON()).toMatchObject({ children: ["here"] });
    act(() => store.change({ name: "changed" }));
    expect(root.toJSON()).toMatchObject({ children: ["changed"] });
    act(() => root.unmount());
    expect(store.listeners.size).toBe(0);
});

/** A plugin's own change source, not a Flux store */
class Counter implements ChangeSource {
    count = 0;
    private readonly listeners = new Set<() => void>();
    addChangeListener(listener: () => void) { this.listeners.add(listener); }
    removeChangeListener(listener: () => void) { this.listeners.delete(listener); }
    bump() {
        this.count++;
        for (const l of [...this.listeners]) l();
    }
}

test("useStore and subscribe take a plugin's own change source", () => {
    const counter = new Counter();
    function Count() {
        return React.createElement("span", null, String(useStore(counter, () => counter.count)));
    }
    let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(Count)); });
    act(() => counter.bump());
    expect(root.toJSON()).toMatchObject({ children: ["1"] });
    act(() => root.unmount());
});

const { createMist } = await import("../src/index");
const { fakeContext } = await import("../src/testing");
const { mistNative, settle } = await import("./helpers");

test("a store read in start before Discord made it is a warning for that plugin: logged once, in its status each run", () => {
    evi.removeStore("PresenceStore");
    const mist = createMist("t-early-read");
    const listened: unknown[] = [];
    const definition = mist.define({
        start(ctx) { ctx.onDispose(subscribe([stores.presence], () => listened.push("change"))); },
    });
    const first = fakeContext({ native: mistNative(false), id: "t-early-read" });
    definition.start!(first.ctx);
    const warnings = () => (globalThis as any).Mist.get("t-early-read").state().warnings;
    expect(warnings()).toEqual([expect.stringContaining('PresenceStore before Discord made it')]);
    expect(warnings()[0]).toContain('subscribe(["PresenceStore"], …)');
    expect(first.logs.filter(p => p.level === "warn").map(p => p.args[0])).toEqual(warnings());

    first.dispose();
    const second = fakeContext({ native: mistNative(false), id: "t-early-read" });
    definition.start!(second.ctx);
    expect(warnings()).toHaveLength(1);
    expect(second.logs.filter(p => p.level === "warn")).toEqual([]);

    second.dispose();
    evi.addStore("PresenceStore", fakeStore({}));
    definition.start!(fakeContext({ native: mistNative(false), id: "t-early-read" }).ctx);
    expect(warnings()).toEqual([]);
});

test("only the synchronous part of start is watched, only the starting plugin is blamed, and a store named to subscribe isn't a read", async () => {
    evi.removeStore("SessionsStore");
    evi.removeStore("MultiAccountStore");
    const mine = createMist("t-start-sync");
    const other = createMist("t-start-other");
    const definition = mine.define({
        async start(ctx) {
            ctx.onDispose(subscribe(["SessionsStore"], () => { }));
            await settle();
            void stores.multiAccount;
        },
    });
    other.define({});
    const started = definition.start!(fakeContext({ native: mistNative(false) }).ctx);
    void stores.multiAccount;
    await started;
    const Mist = (globalThis as any).Mist;
    expect(Mist.get("t-start-sync").state().warnings).toEqual([]);
    expect(Mist.get("t-start-other").state().warnings).toEqual([]);
});
