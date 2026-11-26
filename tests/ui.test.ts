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
/** Evi's Components: what each test puts in `discordComponents`, read when a control renders */
let discordComponents: { Button?: unknown; Tooltip?: unknown; Switch?: unknown; } = {};
const Components = {
    get Button() { return discordComponents.Button; },
    get Tooltip() { return discordComponents.Tooltip; },
    get Switch() { return discordComponents.Switch; },
};
const eviApi = () => ({ ...evi.module, Components, find: () => undefined, filters: { ...evi.module.filters, componentByCode: () => () => false } });
mock.module("@evi/api", eviApi);
mock.module("mist-test-evi-api", eviApi);
const ui = await import("../src/ui");
const { logOnce } = await import("../src/ui/shared");
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

test("state's use() and onChange() work as mist.data's do: use re-renders, onChange hears each new value until removed", () => {
    const count = ui.state(1);
    const heard: number[] = [];
    const off = count.onChange(value => heard.push(value));
    count.set(2);
    count.set(2);
    count.update(n => n * 10);
    off();
    count.set(30);
    expect(heard).toEqual([2, 20]);

    // A listener that throws doesn't keep the next one from hearing
    const after: number[] = [];
    const offThrows = count.onChange(() => { throw new Error("listener broke"); });
    const offAfter = count.onChange(value => after.push(value));
    quietly(() => count.set(31));
    expect(after).toEqual([31]);
    offThrows();
    offAfter();

    const root = render(h(() => h("span", null, `${count.use()}`)));
    expect(text(root)).toBe("31");
    act(() => count.set(32));
    expect(text(root)).toBe("32");
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

test("a send listener that throws or sets a non-string content is logged once, and the message goes on without its changes", async () => {
    const { sent, go } = sendFixture();
    const { mist, run } = plugin("t-send-throws");
    ui.messages.beforeSend(mist, "a-throws", draft => { draft.content = "lost"; throw new Error("listener broke"); });
    ui.messages.beforeSend(mist, "b-number", draft => { (draft as { content: unknown; }).content = 42; });
    await go("one");
    await go("two");
    expect(sent).toEqual(["one", "two"]);
    expect(errors(run).map(l => l.args[0])).toEqual([
        "t-send-throws/a-throws threw before a message went out; the message goes on without its changes",
        "t-send-throws/b-number set the message's content to something other than a string; keeping the content it had",
    ]);
    // The thrown error goes with its line; a bad content has no error to pass on
    expect(errors(run).map(l => l.args.length)).toEqual([2, 1]);
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
    expect(() => ui.host("t-incompatible")).toThrow("The UI state mist-api.ui/host/t-incompatible@1 was made by an incompatible copy of mist-api");
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

test("a registry takes only the plugin's mist object, so one plugin can't add under another's id", () => {
    const victim = plugin("t-owner-victim");
    const forged = { id: "t-owner-victim", ctx: victim.run.ctx, log: victim.mist.log };
    for (const owner of [forged, "t-owner-victim", victim.run.ctx, null]) {
        expect(() => ui.messages.beforeSend(owner as never, "x", () => { })).toThrow(TypeError);
        expect(() => other.chatBar.add(owner as never, "x", () => null)).toThrow("chatBar.add takes the mist object from createMist");
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

/** A page's head, as far as the stylesheet goes: the style elements in it */
function fakeDocument() {
    const head: { textContent: string; dataset: Record<string, string>; remove(): void; }[] = [];
    const page = globalThis as { document?: unknown; };
    const before = page.document;
    page.document = {
        createElement: () => {
            const element = { textContent: "", dataset: {}, remove: () => void head.splice(head.indexOf(element), 1) };
            return element;
        },
        head: { append: (element: (typeof head)[number]) => void head.push(element) },
    };
    return { head, restore: () => void (page.document = before) };
}

/** Discord's legacy Button, recording the props it got */
function discordButton() {
    const got: Record<string, unknown>[] = [];
    const Button = Object.assign((props: Record<string, unknown>) => (got.push(props), h("button", null, props.children as React.ReactNode)), {
        Colors: { BRAND: "brand", PRIMARY: "primary", RED: "red" },
        Sizes: { SMALL: "small", MEDIUM: "medium", LARGE: "large" },
    });
    return { Button, got };
}

test("Button uses Discord's button with its colour and size, and a styled plain button without it", () => {
    const { Button, got } = discordButton();
    discordComponents = { Button };
    try {
        render(h(ui.Button, { variant: "danger", size: "medium", onClick: () => { } }, "Clear"));
        expect(got[0]).toMatchObject({ color: "red", size: "medium", disabled: false, submitting: false, type: "button", children: "Clear" });
        render(h(ui.Button, { variant: "primary", busy: true, label: "Saving" }, "Save"));
        expect(got[1]).toMatchObject({ color: "brand", size: "small", disabled: true, submitting: true, "aria-busy": true, "aria-label": "Saving" });
        const link = render(h(ui.Button, { variant: "link" }, "Learn more"));
        expect(link.root.findByType("button").props).toMatchObject({ className: "mist-button", "data-variant": "link" });
        expect(got).toHaveLength(2);
    } finally {
        discordComponents = {};
    }

    let clicks = 0;
    const plain = render(h(ui.Button, { onClick: () => void clicks++ }, "Connect"));
    const button = plain.root.findByType("button");
    expect(button.props).toMatchObject({ type: "button", className: "mist-button", "data-variant": "secondary", "data-size": "small", disabled: false });
    act(() => button.props.onClick());
    expect(clicks).toBe(1);
    expect(render(h(ui.Button, { busy: true }, "Wait")).root.findByType("button").props).toMatchObject({ disabled: true, "aria-busy": true });
});

test("Tip uses Discord's tooltip, and a title attribute without it", () => {
    const tips: unknown[] = [];
    discordComponents = { Tooltip: (props: { text: string; position?: string; children: React.ReactNode; }) => (tips.push([props.text, props.position]), props.children) };
    try {
        const root = render(h(ui.Tip, { text: "Opens in your browser", position: "bottom", children: h("span", null, "?") }));
        expect(tips).toEqual([["Opens in your browser", "bottom"]]);
        expect(root.root.findByType("span").props.title).toBeUndefined();
    } finally {
        discordComponents = {};
    }
    const root = render(h(ui.Tip, { text: "Opens in your browser", children: h("span", null, "?") }));
    expect(root.root.findByType("span").props.title).toBe("Opens in your browser");
});

test("Row lays out a title, a description and actions; Card and Callout wrap their content", () => {
    const row = render(h(ui.Card, null, h(ui.Row, { title: "Weather service", description: "Signed in as rain", actions: h(ui.Button, null, "Sign out") }, h("i", null, "more"))));
    expect(text(row)).toBe("Weather serviceSigned in as rainSign outmore");
    expect(row.root.findByProps({ className: "mist-card" })).toBeTruthy();
    expect(row.root.findByProps({ className: "mist-row-actions" })).toBeTruthy();
    expect(render(h(ui.Row, { title: "Bare" })).root.findAllByProps({ className: "mist-row-description" })).toHaveLength(0);

    const callout = render(h(ui.Callout, { tone: "warning", title: "Heads up" }, "The service is slow today."));
    expect(callout.root.findByProps({ role: "note" }).props["data-tone"]).toBe("warning");
    expect(text(callout)).toBe("Heads upThe service is slow today.");
    expect(render(h(ui.Callout, null, "x")).root.findByProps({ role: "note" }).props["data-tone"]).toBe("info");
});

test("the stylesheet is added once, however many pieces are mounted, and removed when the last one unmounts", () => {
    const page = fakeDocument();
    try {
        let a!: ReactTestRenderer, b!: ReactTestRenderer;
        act(() => { a = create(h(ui.Card, null, h(ui.Button, null, "x"))); });
        act(() => { b = create(h(ui.Callout, null, "y")); });
        expect(page.head).toHaveLength(1);
        expect(page.head[0].dataset.mist).toBe("ui");
        expect(page.head[0].textContent).toContain(".mist-button");
        expect(page.head[0].textContent).toContain(".mist-switch[aria-checked=\"true\"]");
        expect(page.head[0].textContent).toContain(".mist-input[aria-invalid=\"true\"]");
        expect(page.head[0].textContent).toContain("var(--");
        act(() => a.unmount());
        expect(page.head).toHaveLength(1);
        act(() => b.unmount());
        expect(page.head).toHaveLength(0);
        act(() => { a = create(h(ui.Row, { title: "again" })); });
        expect(page.head).toHaveLength(1);
        act(() => a.unmount());
        expect(page.head).toHaveLength(0);
    } finally {
        page.restore();
    }
});

test("a host's set after its component threw shows the new component, not the old fallback", () => {
    const Panel = ui.host("t-host/reload");
    const first = fakeContext({ id: "t-host-reload" });
    Panel.set(first.ctx, () => { throw new Error("old run"); }, { fallback: h("em", null, "unavailable") });
    const root = quietly(() => render(h(Panel.Component)));
    expect(text(root)).toBe("unavailable");

    // The reloaded plugin sets its fixed component under the same host
    const second = fakeContext({ id: "t-host-reload" });
    act(() => void other.host("t-host/reload").set(second.ctx, () => h("h1", null, "fixed")));
    expect(text(root)).toBe("fixed");
    act(() => { first.dispose(); second.dispose(); });
});

test("adding an entry again under the id of one that threw renders the new entry instead of the old fallback", () => {
    const ChatBar = load(patch(chatBarModule, ui.chatBar.patches), { jsx }).A;
    const { mist, run } = plugin("t-chat-reload");
    ui.chatBar.add(mist, "b", () => { throw new Error("old run"); }, { fallback: h("oops") });
    const root = quietly(() => render(h(ChatBar, { channel: { id: "1" } })));
    const types = () => (root.toJSON() as { children: { type: string; }[]; }).children.map(c => c.type);
    expect(types()).toEqual(["app-launcher", "oops", "send"]);
    act(() => void ui.chatBar.add(mist, "b", () => h("fixed")));
    expect(types()).toEqual(["app-launcher", "fixed", "send"]);
    act(() => run.dispose());
});

test("a button entry with fallback: undefined renders nothing when it throws, as one without the option does", () => {
    const ChatBar = load(patch(chatBarModule, ui.chatBar.patches), { jsx }).A;
    const { mist, run } = plugin("t-chat-undefined");
    ui.chatBar.add(mist, "broken", () => { throw new Error("broken button"); }, { fallback: undefined });
    const root = quietly(() => render(h(ChatBar, { channel: { id: "1" } })));
    expect((root.toJSON() as { children: { type: string; }[]; }).children.map(c => c.type)).toEqual(["app-launcher", "send"]);
    act(() => run.dispose());
});

test("a send listener that times out can't change the message when it finishes later, while the next listener runs", async () => {
    jest.useFakeTimers();
    try {
        const { sent, go } = sendFixture();
        const { mist, run } = plugin("t-send-late");
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
        let seen: string | undefined;
        ui.messages.beforeSend(mist, "a-slow", async draft => { await sleep(6000); draft.content = "late"; });
        ui.messages.beforeSend(mist, "b-next", async draft => {
            seen = draft.content;
            await sleep(2000);
            draft.content += "!";
        });
        const ticks = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
        const going = go("one");
        await ticks();
        jest.advanceTimersByTime(5000);
        await ticks();
        // a-slow finishes while b-next is still running
        jest.advanceTimersByTime(1000);
        await ticks();
        jest.advanceTimersByTime(1000);
        await going;
        expect(seen).toBe("one");
        expect(sent).toEqual(["one!"]);
        act(() => run.dispose());
    } finally {
        jest.useRealTimers();
    }
});

test("after 50 distinct errors a plugin's log says further errors are suppressed, once", () => {
    const logged: unknown[][] = [];
    const mist = { log: { error: (...args: unknown[]) => void logged.push(args) } };
    const Throws = ({ n }: { n: number; }) => { throw new Error(`error ${n}`); };
    quietly(() => render(h("div", null, ...Array.from({ length: 52 }, (_, n) => h(ui.Boundary, { key: n, mist, fallback: null }, h(Throws, { n }))))));
    expect(logged).toHaveLength(51);
    expect(logged.slice(0, 50).every(args => args[0] === "A component threw while rendering; showing its fallback")).toBe(true);
    expect(logged[50]).toEqual(["mist-api/ui: 50 distinct errors logged; further errors suppressed"]);
});

test("logOnce passes an error only when given one, tells a line with an error from the same line without, and caps each log", () => {
    const logged: unknown[][] = [];
    const log = { error: (...args: unknown[]) => void logged.push(args) };
    const err = new Error("boom");
    logOnce(log, "plain");
    logOnce(log, "plain");
    logOnce(log, "plain", err);
    logOnce(log, "plain", new Error("boom"));
    logOnce(log, "plain", undefined);
    expect(logged).toEqual([["plain"], ["plain", err], ["plain", undefined]]);

    for (let n = 0; n < 60; n++) logOnce(log, `line ${n}`);
    expect(logged).toHaveLength(51);
    expect(logged[50]).toEqual(["mist-api/ui: 50 distinct errors logged; further errors suppressed"]);

    // Another log has its own count
    const fresh: unknown[][] = [];
    logOnce({ error: (...args: unknown[]) => void fresh.push(args) }, "line 0");
    expect(fresh).toEqual([["line 0"]]);
});

/** Discord's switch, recording the props it got */
function discordSwitch() {
    const got: Record<string, unknown>[] = [];
    const Switch = (props: Record<string, unknown>) => (got.push(props), h("input", { type: "checkbox", id: props.id as string }));
    return { Switch, got };
}

test("Switch without Discord's is a labelled role=switch button that toggles, and a disabled one can't be pressed", () => {
    const changes: boolean[] = [];
    const root = render(h(ui.Switch, { id: "rain", checked: false, onChange: v => void changes.push(v), label: "Rain alerts", description: "When it starts raining", className: "mine" }));
    const button = root.root.findByType("button");
    expect(button.props).toMatchObject({
        type: "button", role: "switch", id: "rain", className: "mist-switch", "aria-checked": false,
        "aria-labelledby": "rain-label", "aria-describedby": "rain-description", disabled: false,
    });
    expect(root.root.findByType("label").props).toMatchObject({ id: "rain-label", htmlFor: "rain" });
    expect(root.root.findByProps({ className: "mist-switch-row mine" })).toBeTruthy();
    expect(text(root)).toBe("Rain alertsWhen it starts raining");
    act(() => button.props.onClick());
    expect(changes).toEqual([true]);

    const on = render(h(ui.Switch, { checked: true, onChange() { }, disabled: true, "aria-label": "Rain alerts", className: "mine" })).root.findByType("button");
    expect(on.props).toMatchObject({ "aria-checked": true, "aria-label": "Rain alerts", disabled: true, className: "mist-switch mine" });

    // Without an id, the label still points at the generated one
    const generated = render(h(ui.Switch, { checked: false, onChange() { }, label: "Snow" })).root;
    expect(generated.findByType("button").props["aria-labelledby"]).toBe(generated.findByType("label").props.id);
    expect(generated.findByType("label").props.htmlFor).toBe(generated.findByType("button").props.id);
});

test("Switch uses Discord's switch, named by its label or a hidden aria-label, and its own when there's no name to give it", () => {
    const { Switch, got } = discordSwitch();
    discordComponents = { Switch };
    try {
        const onChange = () => { };
        render(h(ui.Switch, { id: "rain", checked: true, onChange, label: "Rain alerts", description: "Hourly" }));
        expect(got[0]).toEqual({ checked: true, onChange, disabled: false, id: "rain", labelledBy: "rain-label", describedBy: "rain-description" });

        const bare = render(h(ui.Switch, { id: "snow", checked: false, onChange, disabled: true, "aria-label": "Snow alerts" }));
        expect(got[1]).toMatchObject({ disabled: true, labelledBy: "snow-label", describedBy: undefined });
        expect(bare.root.findByProps({ id: "snow-label" }).props.className).toBe("mist-sr-only");
        expect(text(bare)).toBe("Snow alerts");

        const unnamed = render(h(ui.Switch, { checked: false, onChange }));
        expect(got).toHaveLength(2);
        expect(unnamed.root.findByType("button").props.role).toBe("switch");
    } finally {
        discordComponents = {};
    }
});

test("TextInput is a styled input that reports its value, passes its props on and marks an invalid value", () => {
    const values: string[] = [];
    const keys: string[] = [];
    const root = render(h(ui.TextInput, {
        value: "Oslo", onChange: v => void values.push(v), placeholder: "City", name: "city", maxLength: 40,
        className: "wide", "aria-label": "City", onKeyDown: e => void keys.push(e.key),
    }));
    const input = root.root.findByType("input");
    expect(input.props).toMatchObject({ type: "text", value: "Oslo", placeholder: "City", name: "city", maxLength: 40, className: "mist-input wide", "aria-label": "City", "aria-invalid": undefined });
    act(() => input.props.onChange({ currentTarget: { value: "Oslo!" } }));
    act(() => input.props.onKeyDown({ key: "Enter" }));
    expect(values).toEqual(["Oslo!"]);
    expect(keys).toEqual(["Enter"]);

    const other = render(h(ui.TextInput, { value: "", onChange() { }, type: "password", invalid: true, disabled: true, readOnly: true })).root.findByType("input");
    expect(other.props).toMatchObject({ type: "password", className: "mist-input", "aria-invalid": true, disabled: true, readOnly: true });
    // Without a label or description it's the input alone
    expect(render(h(ui.TextInput, { value: "", onChange() { } })).toJSON()).toMatchObject({ type: "input" });
});

test("TextInput with a label and description is a field whose label points at the input and whose description describes it", () => {
    const field = render(h(ui.TextInput, { id: "city", value: "Oslo", onChange() { }, label: "City", description: "Where the forecast is for", className: "wide" }));
    const input = field.root.findByType("input");
    expect(input.props).toMatchObject({ id: "city", className: "mist-input wide", "aria-describedby": "city-description" });
    expect(field.root.findByType("label").props).toMatchObject({ htmlFor: "city", className: "mist-field-label" });
    expect(field.root.findByProps({ id: "city-description" }).props.className).toBe("mist-field-description");
    expect(field.toJSON()).toMatchObject({ type: "div", props: { className: "mist-field" } });
    expect(text(field)).toBe("CityWhere the forecast is for");

    // Without an id, the label still points at the generated one
    const generated = render(h(ui.TextInput, { value: "", onChange() { }, label: "Country" })).root;
    const id = generated.findByType("input").props.id;
    expect(id).toBeString();
    expect(generated.findByType("label").props.htmlFor).toBe(id);
    expect(generated.findByType("input").props["aria-describedby"]).toBeUndefined();

    // A description alone still describes the input
    const described = render(h(ui.TextInput, { value: "", onChange() { }, "aria-label": "Zip", description: "Five digits" })).root;
    const zip = described.findByType("input");
    expect(described.findAllByType("label")).toHaveLength(0);
    expect(described.findByProps({ id: zip.props["aria-describedby"] }).props.className).toBe("mist-field-description");
});

test("useValue works with mist.data objects and arrays without an infinite render loop", () => {
    const { mist, run } = plugin("t-ui-data-use-value");
    const tabs = mist.data<string[]>("tabs", ["a"]);
    let renders = 0;
    const Tabs = () => {
        renders++;
        return h("span", null, ui.useValue(tabs).join(","));
    };
    const root = render(h(Tabs));
    expect(text(root)).toBe("a");
    expect(renders).toBeLessThanOrEqual(2);
    const before = renders;
    act(() => tabs.set(["a", "b"]));
    expect(text(root)).toBe("a,b");
    expect(renders).toBe(before + 1);
    act(() => { root.unmount(); run.dispose(); });
});
