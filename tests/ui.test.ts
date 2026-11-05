import { afterAll, afterEach, expect, jest, mock, test } from "bun:test";
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

/** The rendered text, as plain data: a failed match on a test instance would print its whole tree */
function text(root: ReactTestRenderer): string {
    const walk = (node: unknown): string => typeof node === "string" ? node : Array.isArray(node) ? node.map(walk).join("") : (node as { children?: unknown[]; } | null)?.children?.map(walk).join("") ?? "";
    return walk(root.toJSON());
}

const errors = (run: ReturnType<typeof fakeContext>) => run.logs.filter(l => l.level === "error");

/** Evi's plugins, by id: each one's manifest permissions, undefined for one that declares none */
const declared: Record<string, unknown> = {};
const page = globalThis as { Evi?: unknown; };
const eviBefore = page.Evi;
page.Evi = { plugins: { get: (id: string) => id in declared ? { manifest: { id, permissions: declared[id] } } : undefined } };
afterAll(() => void (page.Evi = eviBefore));

/** A running plugin that Evi has loaded: its mist, defined and started, and the fake context it runs in */
function plugin(id: string, permissions?: Record<string, unknown>) {
    declared[id] = permissions;
    const mist = createMist(id);
    const definition = mist.define({});
    const run = fakeContext({ id });
    definition.start!(run.ctx);
    return { mist, run };
}

test("Boundary shows a notice with Retry instead of a child that throws, logs once, and renders the child again on retry", () => {
    const run = fakeContext({ id: "t-boundary" });
    let broken = true;
    function Clock() {
        if (broken) throw new Error("no time");
        return h("span", null, "12:00");
    }
    const root = quietly(() => render(h("div", null, h(ui.Boundary, { name: "Clock", mist: { log: run.ctx.logger } }, h(Clock)), h("b", null, "Discord"))));
    expect(text(root)).toBe("Clock couldn't be shown.RetryDiscord");
    expect(errors(run)).toHaveLength(1);
    expect(errors(run)[0].args).toEqual(["Clock threw while rendering; showing its fallback", new Error("no time")]);

    quietly(() => act(() => root.update(h("div", null, h(ui.Boundary, { name: "Clock", mist: { log: run.ctx.logger } }, h(Clock)), h("b", null, "Discord")))));
    quietly(() => act(() => root.root.findByType("button").props.onClick()));
    expect(errors(run)).toHaveLength(1);

    broken = false;
    act(() => root.root.findByType("button").props.onClick());
    expect(text(root)).toBe("12:00Discord");
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
    expect(text(root)).toBe("no weather for Oslo");
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

    const b = plugin("t-chat-b");
    const a = plugin("t-chat-a");
    ui.chatBar.add(b.mist, "timer", ({ channel }) => h("timer", { channel: channel.id }));
    other.chatBar.add(a.mist, "poll", () => h("poll"));
    const root = render(h(ChatBar, { channel: { id: "42" }, type: { analyticsName: "normal" } }));
    const types = () => (root.toJSON() as { children: { type: string; }[]; }).children.map(c => c.type);
    expect(types()).toEqual(["app-launcher", "poll", "timer", "send"]);
    expect(root.root.findByType("timer" as never).props.channel).toBe("42");

    act(() => a.run.dispose());
    act(() => root.update(h(ChatBar, { channel: { id: "42" } })));
    expect(types()).toEqual(["app-launcher", "timer", "send"]);
    act(() => b.run.dispose());
    expect(types()).toEqual(["app-launcher", "send"]);
});

test("a chat bar button that throws renders nothing, logs to its plugin, and leaves the other buttons", () => {
    const ChatBar = load(patch(chatBarModule, ui.chatBar.patches), { jsx }).A;
    const { mist, run } = plugin("t-chat-broken");
    ui.chatBar.add(mist, "a-broken", () => { throw new Error("broken button"); });
    ui.chatBar.add(mist, "b-fine", () => h("fine"));
    const root = quietly(() => render(h(ChatBar, { channel: { id: "1" } })));
    expect((root.toJSON() as { children: { type: string; }[]; }).children.map(c => c.type)).toEqual(["app-launcher", "fine", "send"]);
    expect(errors(run)[0].args[0]).toBe("t-chat-broken/a-broken threw while rendering; showing its fallback");
    act(() => run.dispose());
});

test("adding a chat bar button with an id the plugin already used replaces it, and the old remove leaves the new one", () => {
    const ChatBar = load(patch(chatBarModule, ui.chatBar.patches), { jsx }).A;
    const { mist, run } = plugin("t-chat-replace");
    const removeOld = ui.chatBar.add(mist, "b", () => h("old"));
    ui.chatBar.add(mist, "b", () => h("new"));
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
    const { mist, run } = plugin("t-popover");
    const seen: string[] = [];
    ui.popover.add(mist, "translate", ({ Button: B, channel, message }) => {
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
    const { mist, run } = plugin("t-accessories");
    ui.accessories.add(mist, "a-summary", ({ message, channel }) => h("p", null, `${channel.id}: ${message.content}`));
    ui.accessories.add(mist, "b-broken", () => { throw new Error("broken accessory"); });
    const root = quietly(() => render(h(Accessories, { message: { id: "m", content: "hi" }, channel: { id: "c" } })));
    expect(text(root)).toBe("(edited)c: hit-accessories/b-broken couldn't be shown.Retry");
    act(() => run.dispose());
    expect(text(root)).toBe("(edited)");
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
    const a = plugin("t-send-a");
    const b = plugin("t-send-b");
    const order: string[] = [];
    other.messages.beforeSend(b.mist, "shout", draft => { order.push("b/shout"); draft.content = draft.content.toUpperCase(); });
    ui.messages.beforeSend(a.mist, "trim", async draft => {
        order.push(`a/trim in ${draft.channel.id}`);
        await new Promise(r => setTimeout(r, 5));
        draft.content = draft.content.trim();
    });
    expect(await go("  hi  ")).toEqual({ shouldClear: true, shouldRefocus: true });
    expect(sent).toEqual(["HI"]);
    expect(order).toEqual(["a/trim in c", "b/shout"]);
    a.run.dispose();
    b.run.dispose();
    await go(" plain ");
    expect(sent.at(-1)).toBe(" plain ");
});

test("a send listener that cancels keeps the message in the box, and later listeners don't run", async () => {
    const { sent, go } = sendFixture();
    const { mist, run } = plugin("t-send-cancel");
    let later = false;
    ui.messages.beforeSend(mist, "a-block", draft => ({ cancel: draft.content.includes("password") }));
    ui.messages.beforeSend(mist, "b-later", () => void (later = true));
    expect(await go("my password")).toEqual({ shouldClear: false, shouldRefocus: true });
    expect(sent).toEqual([]);
    expect(later).toBe(false);
    await go("fine");
    expect(sent).toEqual(["fine"]);
    act(() => run.dispose());
});

test("a send listener that throws or sets a non-string content is logged once, and the message goes on as it was", async () => {
    const { sent, go } = sendFixture();
    const { mist, run } = plugin("t-send-throws");
    ui.messages.beforeSend(mist, "a-throws", draft => { draft.content = "lost"; throw new Error("listener broke"); });
    ui.messages.beforeSend(mist, "b-number", draft => { (draft as { content: unknown; }).content = 42; });
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
    const { mist, run } = plugin("t-send-invalid");
    let ran = false;
    ui.messages.beforeSend(mist, "x", () => void (ran = true));
    expect(await go("hi")).toEqual({ shouldClear: false, shouldRefocus: true });
    expect(ran).toBe(false);
    expect(sent).toEqual([]);
    act(() => run.dispose());
});

test("edit listeners see the message, change what's saved, and can cancel the edit", async () => {
    const saved: string[] = [];
    const { edit } = load(patch(editModule, [ui.messages.patches[1]]), { saved: (_c: string, _m: string, content: string) => void saved.push(content) });
    const go = (content: string) => edit(content, { id: "c" }, { id: "m", content: "old" }, async () => ({ valid: true })) as Promise<{ shouldClear: boolean; shouldRefocus: boolean; }>;
    const { mist, run } = plugin("t-edit");
    ui.messages.beforeEdit(mist, "sign", draft => { draft.content = `${draft.content} (from ${draft.message.id})`; });
    ui.messages.beforeEdit(mist, "veto", draft => draft.content.startsWith("no") ? { cancel: true } : undefined);
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

test("hooks that see message content need readMessages in a manifest that declares permissions, and nothing is added without it", async () => {
    const { sent, go } = sendFixture();
    const { mist, run } = plugin("t-gate-undeclared", { network: ["example.com"] });
    const refused = (add: () => unknown) => {
        try {
            add();
        } catch (err) {
            return err;
        }
    };
    const usages = {
        "popover.add": () => ui.popover.add(mist, "x", () => null),
        "accessories.add": () => other.accessories.add(mist, "x", () => null),
        "messages.beforeSend": () => ui.messages.beforeSend(mist, "x", draft => { draft.content = "rewritten"; }),
        "messages.beforeEdit": () => ui.messages.beforeEdit(mist, "x", () => ({ cancel: true })),
    };
    for (const [usage, add] of Object.entries(usages)) {
        expect(refused(add)).toMatchObject({ name: "PluginPermissionError", plugin: "t-gate-undeclared", permission: "readMessages", message: `t-gate-undeclared can't read messages (${usage}): its manifest doesn't declare permissions.readMessages` });
    }
    await go("hello");
    expect(sent).toEqual(["hello"]);
    // The chat bar hands no message, so it needs nothing
    expect(() => ui.chatBar.add(mist, "button", () => null)).not.toThrow();

    const reader = plugin("t-gate-reader", { readMessages: true });
    ui.messages.beforeSend(reader.mist, "x", draft => { draft.content = "rewritten"; });
    await go("hello");
    expect(sent.at(-1)).toBe("rewritten");
    act(() => { run.dispose(); reader.run.dispose(); });
});

test("a registry takes only the plugin's own mist object, so one plugin can't add under another's id", () => {
    const victim = plugin("t-owner-victim");
    const forged = { id: "t-owner-victim", ctx: victim.run.ctx, log: victim.mist.log };
    for (const owner of [forged, "t-owner-victim", victim.run.ctx, null]) {
        expect(() => ui.messages.beforeSend(owner as never, "x", () => { })).toThrow(TypeError);
        expect(() => other.chatBar.add(owner as never, "x", () => null)).toThrow("chatBar.add takes the plugin's own mist object");
    }
    // A mist that Evi hasn't loaded
    const unknown = createMist("t-owner-unknown");
    unknown.define({}).start!(fakeContext({ id: "t-owner-unknown" }).ctx);
    expect(() => ui.popover.add(unknown, "x", () => null)).toThrow(ui.UnknownPluginError);
    act(() => victim.run.dispose());
});

test("a send listener that never settles holds the message 5 seconds, then it goes on as it was and the plugin's log says so once", async () => {
    jest.useFakeTimers();
    try {
        const { sent, go } = sendFixture();
        const { mist, run } = plugin("t-send-hangs");
        ui.messages.beforeSend(mist, "hangs", draft => {
            draft.content = "half-done";
            return new Promise(() => { });
        });
        // Lets the listeners before the hung one run, however many there are, so its timer is set
        const ticks = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
        for (const content of ["one", "two"]) {
            const going = go(content);
            await ticks();
            jest.advanceTimersByTime(4999);
            await ticks();
            expect(sent).not.toContain(content);
            jest.advanceTimersByTime(1);
            await going;
        }
        expect(sent).toEqual(["one", "two"]);
        expect(errors(run).map(l => l.args[0])).toEqual(["t-send-hangs/hangs didn't finish within 5 s; the message goes on without it"]);
        act(() => run.dispose());
    } finally {
        jest.useRealTimers();
    }
});
