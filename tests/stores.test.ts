import { expect, mock, test } from "bun:test";
import * as React from "react";
import { act, create } from "react-test-renderer";

import type { ChangeSource } from "../src/stores";
import { fakeEvi, fakeStore } from "../src/testing";

const evi = fakeEvi({ React });
/** findStore and find as the module under test calls them: a test can swap in Evi's guard, or a webpack that isn't loaded */
let findStoreOnPage = evi.module.findStore;
let findOnPage = evi.module.find;
mock.module("@evi/api", () => ({
    ...evi.module,
    findStore: ((name: string) => findStoreOnPage(name)) as typeof findStoreOnPage,
    find: ((filter: never) => findOnPage(filter)) as typeof findOnPage,
}));
const { currentUserId, isStreamerMode, lookup, store, stores, subscribe, useStore, whenStore } = await import("../src/stores");

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

test("the message, read state, voice, member, relationship and permission stores are looked up by Discord's names", () => {
    const names = ["MessageStore", "ReadStateStore", "VoiceStateStore", "GuildMemberStore", "RelationshipStore", "PermissionStore"];
    const made = names.map(name => ({ name }));
    names.forEach((name, i) => evi.addStore(name, made[i]));
    evi.lookups.length = 0;
    const read = [stores.messages, stores.readStates, stores.voiceStates, stores.guildMembers, stores.relationships, stores.permissions];
    expect(read).toEqual(made as never);
    expect(evi.lookups).toEqual(names);
    for (const name of names) evi.removeStore(name);
    expect(stores.messages).toBeUndefined();
});

test("store reads any store by name, undefined while it's missing or webpack isn't ready", () => {
    const mine = { here: true };
    evi.addStore("TAnyStore", mine);
    expect(store<typeof mine>("TAnyStore")).toBe(mine);
    expect(store("TMissingStore")).toBeUndefined();
    evi.ready = false;
    expect(store("TAnyStore")).toBeUndefined();
    evi.ready = true;
});

/** findStore as Evi's guard makes it for a plugin that declares permissions without readMessages */
function guardingMessages(body: () => unknown) {
    findStoreOnPage = (name => {
        if (/Message/.test(name)) throw Object.assign(new Error(`t can't read messages (${name})`), { name: "PluginPermissionError" });
        return evi.module.findStore(name);
    }) as typeof findStoreOnPage;
    try {
        return body();
    } finally {
        findStoreOnPage = evi.module.findStore;
    }
}

test("a store the plugin's manifest doesn't permit throws Evi's PluginPermissionError instead of looking missing", async () => {
    evi.addStore("MessageStore", { getMessages: () => undefined });
    guardingMessages(() => {
        expect(() => store("MessageStore")).toThrow(expect.objectContaining({ name: "PluginPermissionError" }));
        expect(() => stores.messages).toThrow(expect.objectContaining({ name: "PluginPermissionError" }));
        expect(stores.user).toBeDefined();
    });
    await guardingMessages(() => expect(whenStore("MessageStore")).rejects.toThrow(expect.objectContaining({ name: "PluginPermissionError" })));
    evi.removeStore("MessageStore");
});

test("lookup searches until it finds something, then keeps it without searching again", () => {
    let searched = 0;
    const thing = { tLookupThing: 1 };
    const find = lookup<typeof thing>(value => (searched++, value === thing));
    expect(find()).toBeUndefined();
    const missed = searched;
    expect(missed).toBeGreaterThan(0);
    find();
    expect(searched).toBeGreaterThan(missed);
    evi.addExport(thing);
    expect(find()).toBe(thing);
    const after = searched;
    expect(find()).toBe(thing);
    expect(find()).toBe(thing);
    expect(searched).toBe(after);
});

test("lookup gives undefined while webpack isn't loaded, and finds once it is", () => {
    const thing = { tLookupLate: 1 };
    evi.addExport(thing);
    findOnPage = (() => { throw new Error("Webpack is not ready yet"); }) as typeof findOnPage;
    const find = lookup<typeof thing>(value => value === thing);
    try {
        expect(find()).toBeUndefined();
    } finally {
        findOnPage = evi.module.find;
    }
    expect(find()).toBe(thing);
});

test("whenStore resolves at once with a store Discord has, and once Discord makes one it hasn't", async () => {
    const ready = fakeStore({});
    evi.addStore("TWhenReady", ready);
    expect(await whenStore("TWhenReady")).toBe(ready);

    const late = fakeStore({});
    const waiting = whenStore("TWhenLate");
    evi.addStore("TWhenLate", late);
    expect(await waiting).toBe(late);
});

test("whenStore rejects with the signal's reason on abort, and stops waiting", async () => {
    const abort = new AbortController();
    const waiting = whenStore("TWhenAborted", abort.signal);
    abort.abort();
    await expect(waiting).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    // Made after the abort: nothing is left waiting to be called with it
    let looked = 0;
    evi.addStore("TWhenAborted", new Proxy({}, { get: () => (looked++, undefined) }));
    expect(looked).toBe(0);

    const reason = new Error("stopped");
    await expect(whenStore("TWhenAborted", AbortSignal.abort(reason))).rejects.toBe(reason);
    const custom = new AbortController();
    const customWaiting = whenStore("TWhenCustom", custom.signal);
    custom.abort(reason);
    await expect(customWaiting).rejects.toBe(reason);
});

test("whenStore removes its abort listener once the store arrives", async () => {
    const abort = new AbortController();
    const added: string[] = [];
    const removed: string[] = [];
    const signal = abort.signal;
    const realAdd = signal.addEventListener.bind(signal), realRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => {
        added.push(type);
        realAdd(type, listener, options);
    };
    signal.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) => {
        removed.push(type);
        realRemove(type, listener, options);
    };
    const waiting = whenStore("TWhenListener", signal);
    evi.addStore("TWhenListener", fakeStore({}));
    await waiting;
    expect(added).toEqual(["abort"]);
    expect(removed).toEqual(["abort"]);
    // A store there already: no listener is added at all
    await whenStore("TWhenListener", signal);
    expect(added).toEqual(["abort"]);
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

test("the same listener subscribed twice unsubscribes each subscription separately", () => {
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

test("useStore listens to a source added to its list, and lets go of one taken out, without React warning", () => {
    const a = fakeStore({ n: 1 });
    const b = fakeStore({ n: 10 });
    const c = fakeStore({ n: 100 });
    function Sum({ sources }: { sources: (typeof a)[]; }) {
        return React.createElement("span", null, String(useStore(sources, () => sources.reduce((sum, s) => sum + s.n, 0))));
    }
    const warned: unknown[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
    let root!: ReturnType<typeof create>;
    try {
        act(() => { root = create(React.createElement(Sum, { sources: [a] })); });
        expect(b.listeners.size).toBe(0);
        // The list grows: a dependency array whose length changed would make React keep the old subscription
        act(() => root.update(React.createElement(Sum, { sources: [a, b] })));
        expect(root.toJSON()).toMatchObject({ children: ["11"] });
        expect(b.listeners.size).toBe(1);
        act(() => b.change({ n: 20 }));
        expect(root.toJSON()).toMatchObject({ children: ["21"] });
        act(() => root.update(React.createElement(Sum, { sources: [a, b, c] })));
        act(() => c.change({ n: 200 }));
        expect(root.toJSON()).toMatchObject({ children: ["221"] });
        // The same sources in a new array keep the subscription
        act(() => root.update(React.createElement(Sum, { sources: [a, b, c] })));
        expect(a.listeners.size + b.listeners.size + c.listeners.size).toBe(3);
        act(() => root.update(React.createElement(Sum, { sources: [c] })));
        expect(a.listeners.size + b.listeners.size).toBe(0);
        expect(c.listeners.size).toBe(1);
        act(() => root.unmount());
        expect(c.listeners.size).toBe(0);
    } finally {
        console.error = realError;
    }
    expect(warned.filter(line => !String(line).startsWith("react-test-renderer is deprecated"))).toEqual([]);
});

test("subscribe unsubscribes the sources before one that throws, then throws its error", () => {
    const a = fakeStore({});
    const broken: ChangeSource = { addChangeListener() { throw new Error("can't listen"); }, removeChangeListener() { } };
    let heard = 0;
    expect(() => subscribe([a, "TPendingStore", broken], () => heard++)).toThrow("can't listen");
    expect(a.listeners.size).toBe(0);
    // The wait for the store named before it was stopped too
    const pending = fakeStore({});
    evi.addStore("TPendingStore", pending);
    expect(pending.listeners.size).toBe(0);
    a.change({});
    expect(heard).toBe(0);
});

test("whenStore takes { signal, timeout }, and rejects with a TimeoutError once the timeout passes", async () => {
    const timedOut = whenStore("TWhenTimeout", { timeout: 10 });
    await expect(timedOut).rejects.toThrow(expect.objectContaining({ name: "TimeoutError", message: 'whenStore: timed out waiting for "TWhenTimeout"' }));
    expect(await timedOut.catch(e => e)).toBeInstanceOf(DOMException);
    // Made after the timeout: nothing is left waiting for it
    let looked = 0;
    evi.addStore("TWhenTimeout", new Proxy({}, { get: () => (looked++, undefined) }));
    expect(looked).toBe(0);

    const ready = fakeStore({});
    const arriving = whenStore("TWhenInTime", { timeout: 50 });
    evi.addStore("TWhenInTime", ready);
    expect(await arriving).toBe(ready);
    expect(await whenStore("TWhenInTime", { timeout: 0 })).toBe(ready);

    const reason = new Error("stopped");
    const abort = new AbortController();
    const aborted = whenStore("TWhenOptionsAbort", { signal: abort.signal, timeout: 1000 });
    abort.abort(reason);
    await expect(aborted).rejects.toBe(reason);
    expect(await whenStore("TWhenInTime", {})).toBe(ready);
});

test("whenStore refuses a timeout setTimeout can't hold, which it would run at once", async () => {
    for (const timeout of [3e9, 2_147_483_648, -1, Infinity]) {
        await expect(whenStore("TWhenBadTimeout", { timeout })).rejects.toThrow(RangeError);
    }
    await expect(whenStore("TWhenBadTimeout", { timeout: 3e9 })).rejects.toThrow("whenStore: timeout must be");
    await expect(whenStore("TWhenBadTimeout", { timeout: NaN })).rejects.toThrow(TypeError);
    await expect(whenStore("TWhenBadTimeout", { timeout: "5" as never })).rejects.toThrow(TypeError);
    // Nothing was left waiting
    let looked = 0;
    evi.addStore("TWhenBadTimeout", new Proxy({}, { get: () => (looked++, undefined) }));
    expect(looked).toBe(0);
});

/** A change source a plugin makes, not a Flux store */
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

test("useStore and subscribe take a change source a plugin makes", () => {
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
