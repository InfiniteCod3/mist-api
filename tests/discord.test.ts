import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as React from "react";

import { reviewCode } from "@shared/codeReview";
import { scanBundle } from "@shared/pluginPermissions";

const found = new Map<string, unknown>();
const handlers = new Map<string, Set<(action: any) => void>>();
const dispatcher = {
    subscribe: (type: string, fn: (action: any) => void) => void (handlers.get(type) ?? handlers.set(type, new Set()).get(type)!).add(fn),
    unsubscribe: (type: string, fn: (action: any) => void) => void handlers.get(type)?.delete(fn),
    dispatch: (action: { type: string; [key: string]: unknown; }) => { for (const fn of [...handlers.get(action.type) ?? []]) fn(action); },
};
const subscribed = () => [...handlers.values()].reduce((n, set) => n + set.size, 0);
/** Webpack's exports, as Evi's finders search them */
let exportsOnPage: unknown[] = [];
const i18n = { discordLocale: "en-US" };

mock.module("@evi/api", () => ({
    React,
    Dispatcher: dispatcher,
    I18n: i18n,
    findStore: (name: string) => found.get(name),
    waitFor: () => () => { },
    filters: {
        byStoreName: (name: string) => ({ store: name }),
        byCode: (...code: string[]) => (v: unknown) => typeof v === "function" && code.every(c => String(v).includes(c)),
        byProps: (...props: string[]) => (v: any) => props.every(p => v?.[p] !== undefined),
    },
    find: (filter: (v: unknown) => boolean) => exportsOnPage.find(v => { try { return filter(v); } catch { return false; } }),
    findAll: (filter: (v: unknown) => boolean) => exportsOnPage.filter(v => { try { return filter(v); } catch { return false; } }),
}));

const { accounts, avatarUrl, chat, copy, discord, DiscordApiError, format, navigate, PluginPermissionError, whenConnected } = await import("../src/discord");
const { isDiscordClient } = await import("../src/discord/rest");
const { createMist } = await import("../src/index");

/** Evi's plugins, by id: each one's manifest permissions. Absent from Evi.plugins when undefined. */
let declarations: Record<string, unknown> | undefined;
const pageGlobals = globalThis as { Evi?: unknown; };
const eviBefore = pageGlobals.Evi;
beforeEach(() => {
    declarations = undefined;
    pageGlobals.Evi = { plugins: { get: (id: string) => declarations && id in declarations ? { manifest: { id, permissions: declarations[id] } } : undefined } };
});
afterAll(() => {
    pageGlobals.Evi = eviBefore;
});

/** Not declared in Evi: held to nothing */
const api = discord("t-discord");

const ME = "100000000000000001", ALT = "100000000000000002";
const userStore = (id: string | undefined) => ({ getCurrentUser: () => id ? { id, username: "me" } : undefined });

afterEach(() => {
    found.clear();
    exportsOnPage = [];
    i18n.discordLocale = "en-US";
});

test("accounts.list reads an array or an object of saved accounts, drops entries without an id, and never copies a token", () => {
    const entry = { id: ME, username: "first", discriminator: "0", avatar: "abc", tokenStatus: 2, pushSyncToken: "secret-push", token: "secret" };
    found.set("MultiAccountStore", { getUsers: () => [entry, { username: "no id" }, { id: ALT, tokenStatus: 0 }, entry] });
    expect(accounts.list()).toEqual([
        { id: ME, username: "first", discriminator: "0", avatar: "abc", status: "valid" },
        { id: ALT, username: ALT, discriminator: "0", avatar: null, status: "invalid" },
    ]);
    expect(JSON.stringify(accounts.list())).not.toContain("secret");

    found.set("MultiAccountStore", { getUsers: () => ({ [ALT]: { id: ALT, username: "second", tokenStatus: 1 } }) });
    expect(accounts.list()).toEqual([{ id: ALT, username: "second", discriminator: "0", avatar: null, status: "validating" }]);

    found.set("MultiAccountStore", { getUsers: () => { throw new Error("changed"); } });
    expect(accounts.list()).toEqual([]);
    found.delete("MultiAccountStore");
    expect(accounts.list()).toEqual([]);
});

test("accounts.current is the account switched to while UserStore is empty mid-switch", () => {
    found.set("UserStore", userStore(ME));
    expect(accounts.current()).toBe(ME);

    found.set("UserStore", userStore(undefined));
    found.set("MultiAccountSwitchStore", { getIsSwitchingAccount: () => true, getTargetUserId: () => ALT });
    expect(accounts.current()).toBe(ALT);

    found.set("MultiAccountSwitchStore", { getIsSwitchingAccount: () => false, getTargetUserId: () => ALT });
    expect(accounts.current()).toBeUndefined();
});

test("accounts.on reports a switch, the connection that ends it, and a logout, and stops listening when the last one unsubscribes", () => {
    found.set("UserStore", userStore(ME));
    const seen: unknown[] = [];
    const offSwitching = accounts.on("switching", e => seen.push(["switching", e]));
    const offConnected = accounts.on("connected", e => seen.push(["connected", e]));
    const offSignedOut = accounts.on("signedOut", e => seen.push(["signedOut", e]));

    dispatcher.dispatch({ type: "MULTI_ACCOUNT_SWITCH_START", targetUserId: ALT });
    dispatcher.dispatch({ type: "LOGOUT", isSwitchingAccount: true });
    dispatcher.dispatch({ type: "CONNECTION_OPEN", user: { id: ALT } });
    dispatcher.dispatch({ type: "CONNECTION_OPEN", user: { id: ALT } });
    dispatcher.dispatch({ type: "LOGOUT" });
    expect(seen).toEqual([
        ["switching", { type: "switching", from: ME, to: ALT }],
        ["connected", { type: "connected", id: ALT, from: ME }],
        ["connected", { type: "connected", id: ALT, from: undefined }],
        ["signedOut", { type: "signedOut", id: ALT }],
    ]);

    offSwitching();
    offConnected();
    expect(subscribed()).toBe(3);
    offSignedOut();
    offSignedOut();
    expect(subscribed()).toBe(0);
});

test("a switch Discord starts without a switch action is still reported, and a throwing listener doesn't stop the next", () => {
    found.set("UserStore", userStore(ME));
    const seen: unknown[] = [];
    const thrown: unknown[] = [];
    const realReport = globalThis.reportError;
    globalThis.reportError = err => void thrown.push(err);
    const offs = [
        accounts.on("switching", () => { throw new Error("listener broke"); }),
        accounts.on("switching", e => seen.push(e)),
    ];
    try {
        dispatcher.dispatch({ type: "LOGOUT", isSwitchingAccount: true });
    } finally {
        globalThis.reportError = realReport;
        for (const off of offs) off();
    }
    expect(seen).toEqual([{ type: "switching", from: ME, to: undefined }]);
    expect(thrown).toHaveLength(1);
});

test("whenConnected resolves at once when connected, on the next connection otherwise, and rejects on abort", async () => {
    found.set("UserStore", userStore(ME));
    expect(await whenConnected()).toBe(ME);

    found.set("UserStore", userStore(undefined));
    const next = whenConnected();
    dispatcher.dispatch({ type: "CONNECTION_OPEN", user: { id: ALT } });
    expect(await next).toBe(ALT);
    expect(subscribed()).toBe(0);

    const abort = new AbortController();
    const waiting = whenConnected(abort.signal);
    abort.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
    expect(subscribed()).toBe(0);
});

test("switchTo calls Discord's own switch with the id, and does nothing for the account already signed in", async () => {
    const calls: unknown[][] = [];
    function switchAccount(...args: unknown[]) {
        calls.push(args);
        return Promise.resolve(true);
    }
    // The code Evi's filter matches, as in Discord's function
    switchAccount.toString = () => "function(e){log(`Switching account to ${e}`);dispatch({type:\"MULTI_ACCOUNT_SWITCH_START\"})}";
    await expect(accounts.switchTo(ALT)).rejects.toThrow("isn't available");

    exportsOnPage = [switchAccount];
    found.set("UserStore", userStore(ME));
    await accounts.switchTo(ALT);
    await accounts.switchTo(ME);
    expect(calls).toEqual([[ALT]]);
    await expect(accounts.switchTo("not an id")).rejects.toThrow(TypeError);
});

/** Discord's API client. mist-api keeps the one it finds, so every test answers through this one. */
let answer: (method: string, request: any) => unknown = () => ({});
const requests: { method: string; request: any; }[] = [];
const method = (name: string) => async (request: any) => {
    requests.push({ method: name, request });
    return answer(name, request);
};
const client = { get: method("get"), post: method("post"), put: method("put"), patch: method("patch"), del: method("del") };
/** Answers with `respond` from now on, through the one client */
function serve(respond: typeof answer) {
    answer = respond;
    requests.length = 0;
    exportsOnPage = [superagent, client];
}

const superagent = { get() { }, post() { }, put() { }, patch() { }, del() { }, getXHR() { }, Request() { } };

test("Discord's API client is found and the superagent under it isn't", () => {
    expect(isDiscordClient(superagent)).toBe(false);
    expect(isDiscordClient(client)).toBe(true);
    expect(isDiscordClient(null)).toBe(false);
});

test("rest returns the answer's body and hands Discord's client the path, query, body and signal", async () => {
    serve(() => ({ ok: true, status: 200, body: { id: "1" } }));
    const signal = new AbortController().signal;
    expect(await api.rest.get("/users/@me", { query: { limit: 1 }, signal })).toEqual({ id: "1" });
    await api.rest.del("/channels/1/pins/2", { reason: "cleanup" });
    expect(requests).toEqual([
        { method: "get", request: { url: "/users/@me", query: { limit: 1 }, body: undefined, headers: undefined, reason: undefined, signal, rejectWithError: false } },
        { method: "del", request: { url: "/channels/1/pins/2", query: undefined, body: undefined, headers: undefined, reason: "cleanup", signal: undefined, rejectWithError: false } },
    ]);
});

test("a refused request throws a DiscordApiError with its status, code and retryAfter", async () => {
    serve((_, request) => {
        if (request.url === "/limited") throw { ok: false, status: 429, body: { message: "You are being rate limited.", retry_after: 1.5, code: 0 }, retryAfter: 2 };
        if (request.url === "/offline") throw new Error("Request has been terminated");
        throw { ok: false, status: 403, body: { message: "Missing Access", code: 50001 } };
    });

    const forbidden = await api.rest.patch("/channels/1", { body: { name: "x" } }).catch(e => e);
    expect(forbidden).toBeInstanceOf(DiscordApiError);
    expect(forbidden).toMatchObject({ status: 403, code: 50001, retryAfter: undefined, method: "PATCH", path: "/channels/1", message: "PATCH /channels/1: 403 Missing Access (code 50001)" });

    expect(await api.rest.get("/limited").catch(e => e)).toMatchObject({ status: 429, retryAfter: 2, code: 0 });
    expect(await api.rest.get("/offline").catch(e => e)).toMatchObject({ name: "DiscordApiError", status: 0, message: "GET /offline: no answer Request has been terminated" });
});

test("rest refuses a URL that isn't a path on Discord's API before anything is sent", async () => {
    serve(() => ({}));
    for (const url of ["https://example.com/x", "//example.com/x", "users/@me"]) await expect(api.rest.get(url)).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
});

/** A channel of `count` messages with ids 1..count, answering as Discord's API does: newest first */
function serveChannel(count: number, limited: Set<number> = new Set()) {
    let asked = 0;
    serve((_, request) => {
        asked++;
        if (limited.has(asked)) throw { ok: false, status: 429, body: { retry_after: 0.01 }, retryAfter: 0.01 };
        const { limit, before, after } = request.query;
        const ids = Array.from({ length: count }, (_, i) => i + 1);
        const page = after ? ids.filter(id => id > Number(after)).slice(0, limit) : ids.filter(id => !before || id < Number(before)).slice(-limit);
        return { ok: true, status: 200, body: page.reverse().map(id => ({ id: String(id), channel_id: "9", content: `#${id}`, timestamp: "2026-01-01T00:00:00Z", author: { id: "5", username: "a" } })) };
    });
}

const collect = async (pages: AsyncIterable<{ id: string; }>) => {
    const ids: number[] = [];
    for await (const message of pages) ids.push(Number(message.id));
    return ids;
};

test("messages pages from the newest back to the first, newest first, a hundred at a time", async () => {
    serveChannel(250);
    const ids = await collect(api.messages("9"));
    expect(ids).toEqual(Array.from({ length: 250 }, (_, i) => 250 - i));
    expect(requests.map(r => r.request.query)).toEqual([{ limit: 100 }, { limit: 100, before: "151" }, { limit: 100, before: "51" }]);
});

test("messages from after an id pages forward, oldest first, and stops at the limit", async () => {
    serveChannel(250);
    expect(await collect(api.messages("9", { after: "10", limit: 120 }))).toEqual(Array.from({ length: 120 }, (_, i) => 11 + i));
    expect(requests.map(r => r.request.query)).toEqual([{ limit: 100, after: "10" }, { limit: 20, after: "110" }]);
    expect(await collect(api.messages("9", { before: "5" }))).toEqual([4, 3, 2, 1]);
});

test("messages waits out a 429 and asks for the same page again", async () => {
    serveChannel(150, new Set([2, 3]));
    expect(await collect(api.messages("9"))).toHaveLength(150);
    expect(requests.map(r => r.request.query.before)).toEqual([undefined, "51", "51", "51"]);
});

test("messages skips entries that aren't messages and refuses both before and after", async () => {
    serve(() => ({ ok: true, status: 200, body: [{ id: "2", channel_id: "9", content: "ok", timestamp: "t", author: { id: "5", username: "a" } }, { id: "1" }, null] }));
    expect(await collect(api.messages("9"))).toEqual([2]);
    await expect(collect(api.messages("9", { before: "1", after: "2" } as never))).rejects.toThrow(TypeError);
});

const ok = () => ({ ok: true, status: 200, body: [] });
/** What a plugin that declares `permissions` gets from rest */
function declared(permissions: Record<string, unknown>) {
    declarations = { "t-declared": permissions };
    serve(ok);
    return discord("t-declared");
}
const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (e: unknown) => e);

test("a plugin that declares permissions without discord.com is refused before anything is sent", async () => {
    const { rest } = declared({ network: ["api.example.com"], readMessages: true, sendMessages: true, changeSettings: true });
    const err = await refusal(rest.get("/users/@me"));
    expect(err).toBeInstanceOf(PluginPermissionError);
    expect(err).toMatchObject({ name: "PluginPermissionError", plugin: "t-declared", permission: "network", target: "discord.com", message: "t-declared can't contact discord.com: its manifest doesn't list it in permissions.network" });
    expect(await refusal(declared({}).rest.get("/users/@me"))).toMatchObject({ permission: "network" });
    // A site that isn't one (no dot) is dropped, not read as covering every .com
    expect(await refusal(declared({ network: ["com"] }).rest.get("/users/@me"))).toMatchObject({ permission: "network" });
    expect(requests).toHaveLength(0);
});

test("a declared site covers its subdomains and reads in any case, as in Evi", async () => {
    await declared({ network: ["Discord.com"] }).rest.get("/users/@me");
    expect(requests).toHaveLength(1);
});

test("GET needs only network, even on a write endpoint", async () => {
    const { rest } = declared({ network: ["discord.com"] });
    await rest.get("/channels/1/messages");
    await rest.get("/users/@me/settings-proto/1");
    expect(requests.map(r => r.request.url)).toEqual(["/channels/1/messages", "/users/@me/settings-proto/1"]);
});

test("POST to a channel's messages is refused without sendMessages and sent with it", async () => {
    const err = await refusal(declared({ network: ["discord.com"] }).rest.post("/channels/1/messages", { body: { content: "hi" } }));
    expect(err).toMatchObject({ name: "PluginPermissionError", permission: "sendMessages", message: "t-declared can't send messages (discord.com): its manifest doesn't declare permissions.sendMessages" });
    expect(requests).toHaveLength(0);

    await declared({ network: ["discord.com"], sendMessages: true }).rest.post("/channels/1/messages", { body: { content: "hi" } });
    expect(requests).toHaveLength(1);
});

test("PATCH to settings-proto is refused without changeSettings", async () => {
    const { rest } = declared({ network: ["discord.com"], sendMessages: true });
    expect(await refusal(rest.patch("/users/@me/settings-proto/1", { body: {} }))).toMatchObject({ permission: "changeSettings", message: "t-declared can't change settings (discord.com): its manifest doesn't declare permissions.changeSettings" });
    expect(requests).toHaveLength(0);
    await declared({ network: ["discord.com"], changeSettings: true }).rest.patch("/users/@me/settings-proto/1", { body: {} });
    expect(requests).toHaveLength(1);
});

test("a path is read as Discord's API reads it: escapes, repeated and trailing slashes, a query, a backslash", async () => {
    const { rest } = declared({ network: ["discord.com"] });
    for (const path of ["/users/%40me", "/users/%40me/settings-proto/1/", "/users//@me/profile", "/channels/1/messages?x=1", "/channels/1/messages#x", "/\channels/1/messages"]) {
        expect({ path, refused: await refusal(rest.patch(path)) }).toMatchObject({ path, refused: { name: "PluginPermissionError" } });
    }
    // One that can't be decoded could be any of them
    expect(await refusal(rest.post("/users/%E0%A4%A"))).toMatchObject({ permission: "sendMessages" });
    expect(requests).toHaveLength(0);
    await rest.patch("/channels/1");
    expect(requests).toHaveLength(1);
});

test("messages is refused without readMessages, before any page is asked for", async () => {
    const err = await refusal(collect(declared({ network: ["discord.com"] }).messages("9")));
    expect(err).toMatchObject({ name: "PluginPermissionError", permission: "readMessages", target: "/channels/9/messages", message: "t-declared can't read messages (/channels/9/messages): its manifest doesn't declare permissions.readMessages" });
    expect(await refusal(collect(declared({ readMessages: true }).messages("9")))).toMatchObject({ permission: "network" });
    expect(requests).toHaveLength(0);

    expect(await collect(declared({ network: ["discord.com"], readMessages: true }).messages("9"))).toEqual([]);
    expect(requests).toHaveLength(1);
});

test("a plugin that declares nothing is allowed everything, as Evi allows it", async () => {
    declarations = { "t-undeclared": undefined };
    serve(ok);
    const plugin = discord("t-undeclared");
    await plugin.rest.post("/channels/1/messages");
    await plugin.rest.patch("/users/@me/settings-proto/1");
    await collect(plugin.messages("9"));
    expect(requests).toHaveLength(3);
});

test("discord takes the plugin's mist object, and refuses what has no id", async () => {
    const mist = createMist("t-declared");
    declarations = { "t-declared": { network: ["discord.com"] } };
    serve(ok);
    expect(await refusal(discord(mist).rest.post("/channels/1/messages"))).toMatchObject({ plugin: "t-declared", permission: "sendMessages" });
    expect(() => discord("")).toThrow(TypeError);
    expect(() => discord({} as never)).toThrow(TypeError);
    expect(() => discord(null as never)).toThrow(TypeError);
});

test("navigate goes through Discord's router and refuses what isn't a path", () => {
    const went: string[] = [];
    const transitionTo = (path: string) => void went.push(path);
    transitionTo.toString = () => "function(e,t){log(`transitionTo - Transitioning to ${e}`)}";
    expect(() => navigate("/channels/@me")).toThrow("isn't available");
    exportsOnPage = [transitionTo];
    navigate("/channels/@me");
    expect(() => navigate("https://example.com")).toThrow(TypeError);
    expect(went).toEqual(["/channels/@me"]);
});

test("avatarUrl gives the user's own avatar at a CDN size, else Discord's default for them", () => {
    expect(avatarUrl({ id: ME, avatar: "abc" })).toBe(`https://cdn.discordapp.com/avatars/${ME}/abc.webp?size=128`);
    expect(avatarUrl({ id: ME, avatar: "abc" }, 100)).toBe(`https://cdn.discordapp.com/avatars/${ME}/abc.webp?size=128`);
    expect(avatarUrl({ id: ME, avatar: "abc" }, 9000)).toBe(`https://cdn.discordapp.com/avatars/${ME}/abc.webp?size=4096`);
    expect(avatarUrl({ id: ME, avatar: null, discriminator: "1237" })).toBe("https://cdn.discordapp.com/embed/avatars/2.png");
    expect(avatarUrl({ id: "80351110224678912", discriminator: "0" })).toBe(`https://cdn.discordapp.com/embed/avatars/${Number((80351110224678912n >> 22n) % 6n)}.png`);
});

test("copy uses Discord's desktop clipboard, and the browser's where there's none", async () => {
    const copied: string[] = [];
    const page = globalThis as { window?: unknown; navigator: Navigator; };
    const hadWindow = "window" in page;
    const realClipboard = Object.getOwnPropertyDescriptor(page.navigator, "clipboard");
    try {
        page.window = { DiscordNative: { clipboard: { copy: (text: string) => void copied.push(`desktop ${text}`) } } };
        await copy("a");
        page.window = {};
        Object.defineProperty(page.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void copied.push(`browser ${text}`) } });
        await copy("b");
    } finally {
        if (hadWindow) { /* Bun has no window: nothing to restore */ } else delete page.window;
        if (realClipboard) Object.defineProperty(page.navigator, "clipboard", realClipboard);
        else delete (page.navigator as { clipboard?: unknown; }).clipboard;
    }
    expect(copied).toEqual(["desktop a", "browser b"]);
});

test("a plugin that imports copy shows its clipboard and desktop bridge use to Evi's store review; one that doesn't carries neither", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mist-discord-"));
    const source = resolve(import.meta.dir, "../src/discord.ts").replaceAll("\\", "/");
    try {
        writeFileSync(join(dir, "copies.ts"), `import { copy } from "${source}";\nexport default { start() { void copy("hi"); } };\n`);
        writeFileSync(join(dir, "formats.ts"), `import { format } from "${source}";\nexport default { start() { format.clock(1); } };\n`);
        const bundle = async (entry: string) => {
            const built = await Bun.build({ entrypoints: [join(dir, entry)], target: "browser", format: "cjs", external: ["@evi/api", "react"] });
            expect(built.success).toBe(true);
            return built.outputs[0].text();
        };
        const [copies, formats] = await Promise.all([bundle("copies.ts"), bundle("formats.ts")]);
        expect(scanBundle(copies).clipboardWrite).toBe(true);
        expect(reviewCode({ code: copies }).flags.find(f => f.id === "discordNative")?.details).toEqual(["DiscordNative.clipboard"]);
        expect(scanBundle(formats).clipboardWrite).toBe(false);
        expect(formats).not.toContain("DiscordNative");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("format writes in Discord's language, not the system's, and follows a change of it", () => {
    const at = Date.UTC(2026, 10, 4, 12);
    i18n.discordLocale = "de-DE";
    expect(format.locale()).toBe("de-DE");
    expect(format.date(at, { dateStyle: "long", timeZone: "UTC" })).toBe("4. November 2026");
    expect(format.ago(at - 86_400_000, at)).toBe("gestern");
    expect(format.duration(3_723_000)).toBe("1 Stunde, 2 Minuten");

    i18n.discordLocale = "en-US";
    expect(format.date(at, { dateStyle: "long", timeZone: "UTC" })).toBe("November 4, 2026");
    expect(format.ago(at - 5 * 60_000, at)).toBe("5 minutes ago");
    expect(format.ago(at + 2 * 3_600_000, at)).toBe("in 2 hours");
    expect(format.ago(at - 10_000, at)).toBe("now");
    expect(format.date("not a date")).toBe("Invalid Date");
});

test("format.clock reads like a timer, with hours only when there are some", () => {
    expect(format.clock(245_000)).toBe("4:05");
    expect(format.clock(3_723_000)).toBe("1:02:03");
    expect(format.clock(999)).toBe("0:00");
    expect(format.clock(-5000)).toBe("0:00");
    expect(format.clock(Number.NaN)).toBe("0:00");
});

test("format.duration shows the largest units, and words them the same without Intl.DurationFormat", () => {
    expect(format.duration(90_061_000)).toBe("1 day, 1 hour");
    expect(format.duration(86_400_000 + 5 * 60_000)).toBe("1 day");
    expect(format.duration(90_061_000, { units: 4 })).toBe("1 day, 1 hour, 1 minute, 1 second");
    expect(format.duration(400)).toBe("0 seconds");
    expect(format.duration(3_723_000, { style: "short" })).toBe("1 hr, 2 min");

    const intl = Intl as { DurationFormat?: unknown; };
    const real = intl.DurationFormat;
    delete intl.DurationFormat;
    try {
        expect(format.duration(3_723_000)).toBe("1 hour, 2 minutes");
        i18n.discordLocale = "de-DE";
        expect(format.duration(3_723_000)).toBe("1 Stunde, 2 Minuten");
    } finally {
        intl.DurationFormat = real;
    }
});

test("chat.insertText types into the open message box, and says when there's none", () => {
    const sent: unknown[] = [];
    const dispatch = (listening: boolean) => ({
        hasSubscribers: (event: string) => listening && event === "INSERT_TEXT",
        dispatchToLastSubscribed: (event: string, payload: unknown) => void sent.push([listening, event, payload]),
    });
    exportsOnPage = [dispatch(false)];
    expect(chat.insertText("hi")).toBe(false);
    exportsOnPage = [dispatch(false), dispatch(true)];
    expect(chat.insertText("hi")).toBe(true);
    expect(sent).toEqual([[true, "INSERT_TEXT", { plainText: "hi", rawText: "hi" }]]);
});

test("chat.localMessage shows Discord's own local message in the open channel, or the one named", () => {
    const shown: unknown[][] = [];
    expect(() => chat.localMessage("hi", "9")).toThrow("aren't available");
    exportsOnPage = [{ sendMessage() { }, sendBotMessage: (...args: unknown[]) => void shown.push(args) }];
    expect(() => chat.localMessage("hi")).toThrow("No channel");
    found.set("SelectedChannelStore", { getChannelId: () => "7" });
    chat.localMessage("hi");
    chat.localMessage("there", "9");
    expect(shown).toEqual([["7", "hi"], ["9", "there"]]);
});
