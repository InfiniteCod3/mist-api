import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { join } from "node:path";
import * as React from "react";
import * as runtime from "react/jsx-runtime";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { fakeContext, fakeEvi } from "../src/testing";
import { copyOfSources } from "./copies";
import { accessoriesModule, chatBarModule, editModule, load, patch, popoverModule, sendModule } from "./fixtures/discord-ui";
import { mistNative } from "./helpers";

const evi = fakeEvi({ React });
const eviApi = () => ({ ...evi.module, find: () => undefined, filters: { ...evi.module.filters, componentByCode: () => () => false } });
mock.module("@evi/api", eviApi);
mock.module("mist-test-evi-api", eviApi);
const ui = await import("../src/ui");
const { createMist } = await import("../src/index");
const { subscribe, useStore } = await import("../src/stores");

const copy = copyOfSources("0.0.3", "mist-test-evi-api");
const other: typeof import("../src/ui") = await import(join(copy.dir, "ui.ts"));
afterAll(copy.remove);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const h = React.createElement;

const mounted: ReactTestRenderer[] = [];
afterEach(() => act(() => { for (const root of mounted.splice(0)) root.unmount(); }));

function render(element: React.ReactElement) {
    let root!: ReactTestRenderer;
    act(() => { root = create(element); });
    mounted.push(root);
    return root;
}

/** React logs each caught render error with console.error; the tests look at the plugin's log instead */
function quietly<T>(fn: () => T): T {
    const error = console.error;
    console.error = () => { };
    try {
        return fn();
    } finally {
        console.error = error;
    }
}

const errors = (run: ReturnType<typeof fakeContext>) => run.logs.filter(l => l.level === "error");

test("Boundary shows a notice with Retry instead of a child that throws, logs once, and renders the child again on retry", () => {
    const run = fakeContext({ id: "t-boundary" });
    let broken = true;
    function Clock() {
        if (broken) throw new Error("no time");
        return h("span", null, "12:00");
    }
    const root = quietly(() => render(h("div", null, h(ui.Boundary, { name: "Clock", mist: { log: run.ctx.logger } }, h(Clock)), h("b", null, "Discord"))));
    const notice = root.root.findByProps({ role: "alert" });
    expect(notice.children[0]).toBe("Clock couldn't be shown.");
    expect(root.root.findByType("b").children).toEqual(["Discord"]);
    expect(errors(run)).toHaveLength(1);
    expect(errors(run)[0].args).toEqual(["Clock threw while rendering; showing its fallback", new Error("no time")]);

    quietly(() => act(() => root.update(h("div", null, h(ui.Boundary, { name: "Clock", mist: { log: run.ctx.logger } }, h(Clock)), h("b", null, "Discord")))));
    quietly(() => act(() => root.root.findByType("button").props.onClick()));
    expect(errors(run)).toHaveLength(1);

    broken = false;
    act(() => root.root.findByType("button").props.onClick());
    expect(root.root.findByType("span").children).toEqual(["12:00"]);
});

test("boundary() names the wrapped component and passes its fallback function the error and a retry", () => {
    let thrown = 0;
    function Weather({ city }: { city: string; }): React.ReactElement {
        thrown++;
        throw new Error(`no weather for ${city}`);
    }
    const Wrapped = ui.boundary(Weather, { fallback: (error, retry) => h("i", { onClick: retry }, String((error as Error).message)), mist: { log: { error() { } } } });
    expect(Wrapped.displayName).toBe("boundary(Weather)");
    const root = quietly(() => render(h(Wrapped, { city: "Oslo" })));
    expect(root.root.findByType("i").children).toEqual(["no weather for Oslo"]);
    const before = thrown;
    quietly(() => act(() => root.root.findByType("i").props.onClick()));
    expect(thrown).toBeGreaterThan(before);
});

test("Boundary logs through console.error without a mist, and through a plugin's mist.log with one", () => {
    const mist = createMist("t-boundary-mist");
    const definition = mist.define({});
    const run = fakeContext({ native: mistNative(false) });
    definition.start!(run.ctx);
    const Throws = () => { throw new Error("mist boundary"); };
    quietly(() => render(h(ui.Boundary, { mist, fallback: null }, h(Throws))));
    expect(errors(run).some(l => l.args.includes("A component threw while rendering; showing its fallback"))).toBe(true);

    const logged: unknown[][] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
        render(h(ui.Boundary, { fallback: null }, h(() => { throw new Error("console boundary"); })));
    } finally {
        console.error = error;
    }
    expect(logged.some(args => args[0] === "A component threw while rendering; showing its fallback")).toBe(true);
    act(() => run.dispose());
});

test("state notifies on a new value, not on the same one, and works with subscribe, useStore and useValue", () => {
    const count = ui.state(1);
    const seen: number[] = [];
    const off = subscribe(count, () => seen.push(count.get()));
    count.set(2);
    count.set(2);
    count.update(n => n + 1);
    off();
    count.set(4);
    expect(seen).toEqual([2, 3]);

    const root = render(h(() => h("span", null, `${ui.useValue(count)}/${useStore(count, () => count.get() * 10)}`)));
    act(() => count.set(5));
    expect(root.toJSON()).toMatchObject({ children: ["5/50"] });
    act(() => root.unmount());
});

test("a host renders what the running plugin set, nothing once it stops, and is one component in every copy of mist-api", () => {
    const name = "t-host/panel";
    const Panel = ui.host<{ title: string; }>(name);
    expect(other.host<{ title: string; }>(name).Component).toBe(Panel.Component);

    const root = render(h(Panel.Component, { title: "Inbox" }));
    expect(root.toJSON()).toBeNull();

    const first = fakeContext({ id: "t-host" });
    act(() => void Panel.set(first.ctx, ({ title }) => h("h1", null, `old ${title}`)));
    expect(root.toJSON()).toMatchObject({ type: "h1", children: ["old Inbox"] });

    // A hot reload: the new copy sets its component before the old run's disposers have run
    const second = fakeContext({ id: "t-host" });
    act(() => void other.host<{ title: string; }>(name).set(second.ctx, ({ title }) => h("h1", null, `new ${title}`)));
    act(() => first.dispose());
    expect(root.toJSON()).toMatchObject({ type: "h1", children: ["new Inbox"] });

    act(() => second.dispose());
    expect(root.toJSON()).toBeNull();
});

test("a host catches its component's errors in a Boundary logged to the plugin", () => {
    const Panel = ui.host("t-host/broken");
    const run = fakeContext({ id: "t-host-broken" });
    Panel.set(run.ctx, () => { throw new Error("broken panel"); }, { fallback: h("em", null, "unavailable") });
    const root = quietly(() => render(h(Panel.Component)));
    expect(root.toJSON()).toMatchObject({ type: "em" });
    expect(errors(run)[0].args[0]).toBe("t-host-broken's t-host/broken threw while rendering; showing its fallback");
    act(() => run.dispose());
});

const jsx = { jsx: runtime.jsx, jsxs: runtime.jsxs, Fragment: runtime.Fragment };

test("chat bar buttons render in Discord's chat bar before the send button, sorted by plugin and id, until each plugin stops", () => {
    // Two plugins carry the patch, each with its own copy of mist-api
    const code = patch(patch(chatBarModule, ui.chatBar.patches), other.chatBar.patches);
    expect(code.match(/\?\.inject\(\$,arguments\[0\]\)/g)).toHaveLength(1);
    const ChatBar = load(code, { jsx }).A;

    const b = fakeContext({ id: "t-chat-b" });
    const a = fakeContext({ id: "t-chat-a" });
    ui.chatBar.add(b.ctx, "timer", ({ channel }) => h("timer", { channel: channel.id }));
    other.chatBar.add(a.ctx, "poll", () => h("poll"));
    const root = render(h(ChatBar, { channel: { id: "42" }, type: { analyticsName: "normal" } }));
    const types = () => (root.toJSON() as { children: { type: string; }[]; }).children.map(c => c.type);
    expect(types()).toEqual(["app-launcher", "poll", "timer", "send"]);
    expect(root.root.findByType("timer" as never).props.channel).toBe("42");

    act(() => a.dispose());
    act(() => root.update(h(ChatBar, { channel: { id: "42" } })));
    expect(types()).toEqual(["app-launcher", "timer", "send"]);
    act(() => b.dispose());
    expect(types()).toEqual(["app-launcher", "send"]);
});

test("a chat bar button that throws renders nothing, logs to its plugin, and leaves the other buttons", () => {
    const ChatBar = load(patch(chatBarModule, ui.chatBar.patches), { jsx }).A;
    const run = fakeContext({ id: "t-chat-broken" });
    ui.chatBar.add(run.ctx, "a-broken", () => { throw new Error("broken button"); });
    ui.chatBar.add(run.ctx, "b-fine", () => h("fine"));
    const root = quietly(() => render(h(ChatBar, { channel: { id: "1" } })));
    expect((root.toJSON() as { children: { type: string; }[]; }).children.map(c => c.type)).toEqual(["app-launcher", "fine", "send"]);
    expect(errors(run)[0].args[0]).toBe("t-chat-broken/a-broken threw while rendering; showing its fallback");
    act(() => run.dispose());
});

test("adding a chat bar button with an id the plugin already used replaces it, and the old remove leaves the new one", () => {
    const ChatBar = load(patch(chatBarModule, ui.chatBar.patches), { jsx }).A;
    const run = fakeContext({ id: "t-chat-replace" });
    const removeOld = ui.chatBar.add(run.ctx, "b", () => h("old"));
    ui.chatBar.add(run.ctx, "b", () => h("new"));
    removeOld();
    const root = render(h(ChatBar, { channel: { id: "1" } }));
    expect((root.toJSON() as { children: { type: string; }[]; }).children.map(c => c.type)).toEqual(["app-launcher", "new", "send"]);
    act(() => run.dispose());
});

test("hover bar buttons render after the Shift-only buttons with Discord's button, the channel and the message", () => {
    function Button({ label }: { label: string; }) {
        return h("button", { "aria-label": label });
    }
    const HoverBar = load(patch(patch(popoverModule, ui.popover.patches), other.popover.patches), { jsx, Button }).A;
    const run = fakeContext({ id: "t-popover" });
    const seen: string[] = [];
    ui.popover.add(run.ctx, "translate", ({ Button: B, channel, message }) => {
        seen.push(`${channel.id}/${message.id}`);
        return h(B, { label: "Translate", icon: () => null, onClick() { } });
    });
    const root = render(h(HoverBar, { channel: { id: "c" }, message: { id: "m" }, canCopy: true }));
    expect(root.root.findAllByType("button").map(b => b.props["aria-label"])).toEqual(["Copy ID", "Copy Link", "Translate", "More"]);
    expect(seen.at(-1)).toBe("c/m");
    act(() => run.dispose());
    expect(root.root.findAllByType("button").map(b => b.props["aria-label"])).toEqual(["Copy ID", "Copy Link", "More"]);
});

test("accessories render under the message with its props, and one that throws shows the notice in its place", () => {
    const Accessories = load(patch(patch(accessoriesModule, ui.accessories.patches), other.accessories.patches), { jsx, React }).Ay;
    const run = fakeContext({ id: "t-accessories" });
    ui.accessories.add(run.ctx, "a-summary", ({ message, channel }) => h("p", null, `${channel.id}: ${message.content}`));
    ui.accessories.add(run.ctx, "b-broken", () => { throw new Error("broken accessory"); });
    const root = quietly(() => render(h(Accessories, { message: { id: "m", content: "hi" }, channel: { id: "c" } })));
    expect(root.root.findByType("p").children).toEqual(["c: hi"]);
    expect(root.root.findByProps({ role: "alert" }).children[0]).toBe("t-accessories/b-broken couldn't be shown.");
    act(() => run.dispose());
    expect(root.root.findAllByType("p")).toHaveLength(0);
    expect(root.root.findByType("span").children).toEqual(["(edited)"]);
});

function sendFixture(failureReason?: string) {
    const sent: string[] = [];
    const code = patch(patch(sendModule, [ui.messages.patches[0]]), [other.messages.patches[0]]);
    expect(code.match(/\?\.beforeSend\?\.\(\$mistDraft\)/g)).toHaveLength(1);
    const { send } = load(code, { sent: (_: string, content: string) => void sent.push(content) });
    const go = (content: string) => send(content, { id: "c" }, async () => ({ valid: failureReason === undefined, failureReason })) as Promise<{ shouldClear: boolean; shouldRefocus: boolean; }>;
    return { sent, go };
}

test("send listeners run in plugin and id order, may be async, change the content, and see the channel", async () => {
    const { sent, go } = sendFixture();
    const a = fakeContext({ id: "t-send-a" });
    const b = fakeContext({ id: "t-send-b" });
    const order: string[] = [];
    other.messages.beforeSend(b.ctx, "shout", draft => { order.push("b/shout"); draft.content = draft.content.toUpperCase(); });
    ui.messages.beforeSend(a.ctx, "trim", async draft => {
        order.push(`a/trim in ${draft.channel.id}`);
        await new Promise(r => setTimeout(r, 5));
        draft.content = draft.content.trim();
    });
    expect(await go("  hi  ")).toEqual({ shouldClear: true, shouldRefocus: true });
    expect(sent).toEqual(["HI"]);
    expect(order).toEqual(["a/trim in c", "b/shout"]);
    a.dispose();
    b.dispose();
    await go(" plain ");
    expect(sent.at(-1)).toBe(" plain ");
});

test("a send listener that cancels keeps the message in the box, and later listeners don't run", async () => {
    const { sent, go } = sendFixture();
    const run = fakeContext({ id: "t-send-cancel" });
    let later = false;
    ui.messages.beforeSend(run.ctx, "a-block", draft => ({ cancel: draft.content.includes("password") }));
    ui.messages.beforeSend(run.ctx, "b-later", () => void (later = true));
    expect(await go("my password")).toEqual({ shouldClear: false, shouldRefocus: true });
    expect(sent).toEqual([]);
    expect(later).toBe(false);
    await go("fine");
    expect(sent).toEqual(["fine"]);
    act(() => run.dispose());
});

test("a send listener that throws or sets a non-string content is logged once, and the message goes on as it was", async () => {
    const { sent, go } = sendFixture();
    const run = fakeContext({ id: "t-send-throws" });
    ui.messages.beforeSend(run.ctx, "a-throws", draft => { draft.content = "lost"; throw new Error("listener broke"); });
    ui.messages.beforeSend(run.ctx, "b-number", draft => { (draft as { content: unknown; }).content = 42; });
    await go("one");
    await go("two");
    expect(sent).toEqual(["lost", "lost"]);
    expect(errors(run).map(l => l.args[0])).toEqual([
        "t-send-throws/a-throws threw before a message went out; the message goes on",
        "t-send-throws/b-number set the message's content to something other than a string; keeping the content it had",
    ]);
    act(() => run.dispose());
});

test("send listeners don't run for a message Discord turned down", async () => {
    const { sent, go } = sendFixture("slowmode");
    const run = fakeContext({ id: "t-send-invalid" });
    let ran = false;
    ui.messages.beforeSend(run.ctx, "x", () => void (ran = true));
    expect(await go("hi")).toEqual({ shouldClear: false, shouldRefocus: true });
    expect(ran).toBe(false);
    expect(sent).toEqual([]);
    act(() => run.dispose());
});

test("edit listeners see the message, change what's saved, and can cancel the edit", async () => {
    const saved: string[] = [];
    const { edit } = load(patch(editModule, [ui.messages.patches[1]]), { saved: (_c: string, _m: string, content: string) => void saved.push(content) });
    const go = (content: string) => edit(content, { id: "c" }, { id: "m", content: "old" }, async () => ({ valid: true })) as Promise<{ shouldClear: boolean; }>;
    const run = fakeContext({ id: "t-edit" });
    ui.messages.beforeEdit(run.ctx, "sign", draft => { draft.content = `${draft.content} (from ${draft.message.id})`; });
    ui.messages.beforeEdit(run.ctx, "veto", draft => draft.content.startsWith("no") ? { cancel: true } : undefined);
    expect(await go("new")).toEqual({ shouldClear: true, shouldRefocus: true });
    expect(await go("nope")).toEqual({ shouldClear: false, shouldRefocus: true });
    expect(saved).toEqual(["new (from m)"]);
    act(() => run.dispose());
});

test("with no listeners a message isn't held up: the patched code gets false, not a promise", () => {
    const outgoing = (globalThis as unknown as Record<symbol, { beforeSend(d: unknown): unknown; }>)[Symbol.for("mist-api.ui/outgoing@1")];
    expect(outgoing.beforeSend({ channel: { id: "c" }, content: "x" })).toBe(false);
});

test("a registry key held by an incompatible copy fails loudly instead of sharing the wrong shape", () => {
    Object.defineProperty(globalThis, Symbol.for("mist-api.ui/host/t-incompatible@1"), { value: { protocol: 1 }, configurable: true });
    expect(() => ui.host("t-incompatible")).toThrow("mist ui: mist-api.ui/host/t-incompatible@1 was made by an incompatible copy");
});

test("adding UI to a mist whose plugin isn't running throws", () => {
    const mist = createMist("t-ui-stopped");
    mist.define({});
    expect(() => ui.chatBar.add(mist, "x", () => null)).toThrow();
});
