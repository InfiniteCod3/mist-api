import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { act, create } from "react-test-renderer";

import { fakeContext, fakeDispatcher, fakeEvi, fakeStore } from "../src/testing";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

test("the testing module loads no runner and nothing from @evi/api at runtime", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "testing.ts"), "utf8");
    const imports = [...source.matchAll(/^import\s+(type\s+)?.*?from\s+"([^"]+)"/gm)].map(m => [m[1]?.trim() ?? "", m[2]]);
    expect(imports).toEqual([["type", "@evi/api"]]);
});

test("fakeStore notifies its listeners on change, after assigning", () => {
    const store = fakeStore({ n: 1 });
    const heard: number[] = [];
    const listener = () => heard.push(store.n);
    store.addChangeListener(listener);
    store.change({ n: 2 });
    store.removeChangeListener(listener);
    store.change({ n: 3 });
    expect(heard).toEqual([2]);
    expect(store.listeners.size).toBe(0);
});

test("fakeDispatcher calls the handlers of the action's type and keeps what it dispatched", async () => {
    const dispatcher = fakeDispatcher();
    const heard: string[] = [];
    const handler = (action: { type: string; }) => heard.push(action.type);
    dispatcher.subscribe("A", handler);
    await dispatcher.dispatch({ type: "A" });
    await dispatcher.dispatch({ type: "B" });
    dispatcher.unsubscribe("A", handler);
    await dispatcher.dispatch({ type: "A" });
    expect(heard).toEqual(["A"]);
    expect(dispatcher.dispatched.map(a => a.type)).toEqual(["A", "B", "A"]);
});

test("fakeEvi finds stores by name, throws while not ready, and records each lookup", () => {
    const evi = fakeEvi();
    const store = fakeStore({});
    evi.addStore("UserStore", store);
    expect(evi.module.findStore("UserStore")).toBe(store);
    expect(evi.module.findStore("NoStore")).toBeUndefined();
    expect(() => evi.module.getStore("NoStore")).toThrow("Couldn't find store NoStore");
    evi.ready = false;
    expect(() => evi.module.findStore("UserStore")).toThrow();
    expect(evi.lookups).toEqual(["UserStore", "NoStore", "NoStore", "UserStore"]);
    expect(() => evi.module.React).toThrow("fakeEvi({ React })");
});

test("fakeEvi's waitFor calls back at once for a store that exists, later for one added, and not after it stops", () => {
    const evi = fakeEvi();
    const early = fakeStore({ name: "early" });
    evi.addStore("EarlyStore", early);
    const found: unknown[] = [];
    evi.module.waitFor(evi.module.filters.byStoreName("EarlyStore"), store => found.push(store));
    evi.module.waitFor(evi.module.filters.byStoreName("LateStore"), (store, at) => found.push(store, at.id));
    const stop = evi.module.waitFor(evi.module.filters.byStoreName("NeverStore"), store => found.push(store));
    stop();
    const late = fakeStore({ name: "late" });
    evi.addStore("LateStore", late);
    evi.addStore("NeverStore", fakeStore({}));
    expect(found).toEqual([early, late, "fake:LateStore"]);
});

test("fakeContext disposes newest first, logs a throwing disposer, and runs one added after stop at once", () => {
    const run = fakeContext();
    const order: string[] = [];
    run.ctx.onDispose(() => order.push("first"));
    run.ctx.onDispose(() => { throw new Error("boom"); });
    run.ctx.onDispose(() => order.push("last"));
    run.dispose();
    expect(order).toEqual(["last", "first"]);
    expect(run.logs).toEqual([{ level: "error", args: ["Cleanup threw", expect.any(Error)] }]);
    expect(run.disposed).toBe(true);
    run.ctx.onDispose(() => order.push("late"));
    expect(order).toEqual(["last", "first", "late"]);
});

test("fakeContext's settings read stored values over schema defaults, and onChange hears a set until stop", () => {
    const schema = { volume: { type: "number", label: "Volume", default: 50 }, muted: { type: "boolean", label: "Muted", default: false } } as const;
    const run = fakeContext({ schema, settings: { muted: true } });
    expect(run.ctx.settings.get("volume")).toBe(50);
    expect(run.ctx.settings.all).toEqual({ volume: 50, muted: true });
    const heard: unknown[] = [];
    run.ctx.settings.onChange(values => heard.push(values.volume));
    const before = run.ctx.settings.snapshot();
    run.ctx.settings.set("muted", true);
    expect(run.ctx.settings.snapshot()).toBe(before);
    run.ctx.settings.set("volume", 70);
    run.dispose();
    run.ctx.settings.set("volume", 80);
    expect(heard).toEqual([70]);
});

test("fakeContext's settings.use re-renders a component when a setting changes", () => {
    const run = fakeContext({ evi: fakeEvi({ React }), settings: { name: "a" } });
    function Name() {
        return React.createElement("span", null, String(run.ctx.settings.use().name));
    }
    let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(Name)); });
    act(() => run.ctx.settings.set("name", "b"));
    expect(root.toJSON()).toMatchObject({ children: ["b"] });
    act(() => root.unmount());
});

test("fakeContext's flux goes through its fakeEvi's dispatcher, logs a throwing handler, and unsubscribes on stop", async () => {
    const evi = fakeEvi();
    const run = fakeContext({ evi });
    const heard: unknown[] = [];
    run.ctx.flux.subscribe("PRESENCE_UPDATES", action => heard.push(action.updates));
    run.ctx.flux.subscribe("PRESENCE_UPDATES", () => { throw new Error("handler"); });
    await evi.module.Dispatcher.dispatch({ type: "PRESENCE_UPDATES", updates: [1] });
    expect(heard).toEqual([[1]]);
    expect(run.logs.map(l => l.args[0])).toEqual(["Flux handler for PRESENCE_UPDATES threw"]);
    run.dispose();
    await run.ctx.flux.dispatch({ type: "PRESENCE_UPDATES", updates: [2] });
    expect(heard).toEqual([[1]]);
});

test("fakeContext's waitFor finds a store added later, and a stopped plugin's wait never calls back", () => {
    const evi = fakeEvi();
    const run = fakeContext({ evi });
    const stopped = fakeContext({ evi });
    const found: string[] = [];
    run.ctx.waitFor(evi.module.filters.byStoreName("LateStore"), () => found.push("running"));
    stopped.ctx.waitFor(evi.module.filters.byStoreName("LateStore"), () => found.push("stopped"));
    stopped.dispose();
    evi.addStore("LateStore", fakeStore({}));
    expect(found).toEqual(["running"]);
});

test("fakeContext records the logger, styles, and toasts, and calls the native fake", async () => {
    const run = fakeContext({ id: "demo", native: async (method, ...args) => `${method}(${args.join(",")})` });
    run.ctx.logger.info("hello", 1);
    const style = run.ctx.addStyle(".a{}");
    run.ctx.addStyle(".b{}");
    style.update(".a{color:red}");
    expect(run.styles).toEqual([".a{color:red}", ".b{}"]);
    style.remove();
    expect(run.styles).toEqual([".b{}"]);
    run.ctx.toast("saved");
    expect(await run.ctx.native.call("add", 1, 2)).toBe("add(1,2)");
    expect(run.logs).toEqual([{ level: "info", args: ["hello", 1] }]);
    expect(run.toasts).toEqual(["saved"]);
    run.dispose();
    expect(run.styles).toEqual([]);
    expect(() => fakeContext({ id: "page-only" }).ctx.native.call("x")).toThrow("page-only has no native module");
});

test("fakeContext stubs what it doesn't fake with an error naming the override, and takes overrides", () => {
    expect(() => fakeContext().ctx.hook.after({ f() { } }, "f", () => { })).toThrow("overrides: { hook");
    const hooked: string[] = [];
    const run = fakeContext({ overrides: { command: (definition: { name: string; }) => void hooked.push(definition.name) } });
    run.ctx.command({ name: "ping" } as never);
    expect(hooked).toEqual(["ping"]);
});
