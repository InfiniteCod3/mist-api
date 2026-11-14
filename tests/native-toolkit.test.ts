import type { NativeContext } from "@evi/api/native";
import { beforeEach, describe, expect, test } from "bun:test";

import { check, loginWindow, NativeError, openExternal, privateSession } from "../src/native";
import { HttpError } from "../src/util";
import { electron } from "./electron";

const ctx = { pluginId: "t-kit", pluginDir: "", dataDir: "", onBeforeRequest: () => () => { }, onDispose: () => { } } as NativeContext;

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function refusal(fn: () => unknown) {
    try {
        fn();
    } catch (err) {
        return err as NativeError<{ name: string; expected: string; }>;
    }
    throw new Error("expected a refusal");
}

beforeEach(() => electron.reset());

describe("check", () => {
    test("each guard returns the value it accepts", () => {
        expect(check.text("hi", { max: 5 })).toBe("hi");
        expect(check.id("123456789012345678")).toBe("123456789012345678");
        expect(check.int(3, { min: 1, max: 5 })).toBe(3);
        expect(check.bool(false)).toBe(false);
        expect(check.oneOf("b", ["a", "b"] as const)).toBe("b");
        expect(check.https("https://api.example.com/x?y=1").hostname).toBe("api.example.com");
        expect(check.list(["1", "2"], check.id, { max: 2 })).toEqual(["1", "2"]);
        expect(check.record({ a: 1 })).toEqual({ a: 1 });
    });

    test("a refused argument throws a NativeError bad-argument naming it and what it had to be", () => {
        const err = refusal(() => check.text(42, { max: 10, name: "title" }));
        expect(err).toBeInstanceOf(NativeError);
        expect(err.code).toBe("bad-argument");
        expect(err.data).toEqual({ name: "title", expected: "a string of at most 10 characters" });
        expect(err.message).toBe("title must be a string of at most 10 characters");    });

    test("text holds min and max", () => {
        expect(refusal(() => check.text("", { min: 1, max: 3 })).data?.expected).toBe("a string of 1 to 3 characters");
        expect(() => check.text("abcd", { max: 3 })).toThrow(NativeError);
    });

    test("id takes 1 to 20 digits only", () => {
        for (const bad of ["", "123456789012345678901", "12a", 123, " 1", null]) expect(() => check.id(bad)).toThrow(NativeError);
        expect(check.id("1")).toBe("1");
    });

    test("int takes whole numbers in range only", () => {
        for (const bad of [0, 6, 1.5, NaN, Infinity, "3", 2 ** 60]) expect(() => check.int(bad, { min: 1, max: 5 })).toThrow(NativeError);
    });

    test("bool, oneOf and record refuse anything else", () => {
        expect(() => check.bool("true")).toThrow(NativeError);
        expect(refusal(() => check.oneOf("c", ["a", "b"], "mode")).message).toBe('mode must be one of "a", "b"');
        for (const bad of [null, [], "x"]) expect(() => check.record(bad)).toThrow(NativeError);
    });

    test("https refuses other protocols and credentials, and holds a host allowlist with *. for subdomains", () => {
        for (const bad of ["http://example.com", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.com", "not a url", 5, `https://example.com/${"x".repeat(9000)}`]) {
            expect(() => check.https(bad)).toThrow(NativeError);
        }
        const hosts = ["example.com", "*.example.org"];
        expect(check.https("https://example.com/a", { hosts }).href).toBe("https://example.com/a");
        expect(check.https("https://API.example.org", { hosts }).hostname).toBe("api.example.org");
        for (const bad of ["https://www.example.com", "https://example.org", "https://evilexample.org", "https://example.org.evil.com"]) {
            expect(refusal(() => check.https(bad, { hosts, name: "link" })).data).toEqual({ name: "link", expected: "an https URL on example.com, *.example.org" });
        }
    });

    test("list holds max and names the item that failed", () => {
        expect(() => check.list("1", check.id, { max: 3 })).toThrow(NativeError);
        expect(() => check.list(["1", "2"], check.id, { max: 1 })).toThrow(NativeError);
        expect(refusal(() => check.list(["1", "x"], check.id, { max: 5, name: "ids" })).data?.name).toBe("ids[1]");
    });
});

describe("privateSession", () => {
    test("uses the plugin's own persistent partition and denies every permission", async () => {
        const login = privateSession(ctx, "weather");
        expect(login.partition).toBe("persist:t-kit-weather");
        const ses = electron.sessions.get("persist:t-kit-weather")!;
        expect(login.session as unknown).toBe(ses);
        let granted: boolean | undefined;
        ses.permissionRequestHandler!({}, "media", answer => void (granted = answer));
        expect(granted).toBe(false);
        expect(ses.permissionCheckHandler!({}, "clipboard-read")).toBe(false);
        expect(ses.getUserAgent()).toContain("Electron/");
    });

    test("browserUserAgent strips the Electron and discord tokens, also when asked twice", () => {
        privateSession(ctx, "music", { browserUserAgent: true });
        privateSession(ctx, "music", { browserUserAgent: true });
        const agent = electron.sessions.get("persist:t-kit-music")!.getUserAgent();
        expect(agent).not.toMatch(/Electron|discord/i);
        expect(agent).toContain("Chrome/");
    });

    test("a bad name is a TypeError", () => {
        for (const bad of ["", "Has Space", "../x", "a".repeat(41)]) expect(() => privateSession(ctx, bad)).toThrow(TypeError);
    });

    test("json parses a 2xx body through the session, and throws util's HttpError otherwise", async () => {
        electron.fetch = url => url.endsWith("/ok") ? Response.json({ temp: 21 }) : new Response("", { status: 503 });
        const login = privateSession(ctx, "api");
        expect(await login.json("https://api.example.com/ok")).toEqual({ temp: 21 });
        const err = await login.json("https://api.example.com/down").catch((e: HttpError) => e) as HttpError;
        expect(err).toBeInstanceOf(HttpError);
        expect(err.status).toBe(503);
        const ses = electron.sessions.get("persist:t-kit-api")!;
        expect(ses.fetched[0].init?.signal).toBeInstanceOf(AbortSignal);
        expect((await login.fetch("https://api.example.com/ok")).status).toBe(200);
        expect(ses.fetched).toHaveLength(3);
    });

    test("json gives up after its timeout", async () => {
        electron.fetch = (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
        // Bun doesn't fire AbortSignal.timeout while nothing else keeps its event loop busy; Electron's always is
        const busy = setInterval(() => { }, 5);
        try {
            const err = await privateSession(ctx, "slow").json("https://api.example.com/x", { timeout: 10 }).catch(e => e);
            expect(err).toMatchObject({ name: "TimeoutError" });
        } finally {
            clearInterval(busy);
        }
    });

    test("reads cookies for a URL, and clear signs out", async () => {
        const login = privateSession(ctx, "site");
        await login.session.cookies.set({ url: "https://example.com", domain: ".example.com", name: "sid", value: "abc", secure: true });
        expect(await login.cookie("https://www.example.com/page", "sid")).toBe("abc");
        expect(await login.hasCookie("https://example.com", "sid")).toBe(true);
        expect(await login.hasCookie("https://example.net", "sid")).toBe(false);
        expect(await login.cookie("https://example.com", "other")).toBeUndefined();
        await login.clear();
        expect(await login.hasCookie("https://example.com", "sid")).toBe(false);
        await login.flush();
        expect(electron.sessions.get("persist:t-kit-site")!.cookies.flushes).toBe(1);
    });
});

describe("loginWindow", () => {
    test("opens a sandboxed window of the session over Discord's, and resolves true once done answers true", async () => {
        const main = electron.addWindow({ url: "https://discord.com/app", bounds: { x: 100, y: 100, width: 1200, height: 900 } });
        (globalThis as { mainWindowId?: number; }).mainWindowId = main.id;
        const login = privateSession(ctx, "site");
        let loggedIn = false;
        const seen: string[] = [];
        const result = loginWindow(login, { url: "https://example.com/login", title: "Sign in", done: url => (seen.push(url), loggedIn), pollMs: 60_000 });
        const win = electron.windows.at(-1)!;
        expect(win).not.toBe(main);
        expect(win.options).toMatchObject({
            width: 480, height: 720, title: "Sign in", parent: main, x: 460, y: 190, show: false,
            webPreferences: { session: login.session, sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        expect(win.options.webPreferences.preload).toBeUndefined();
        expect(win.loaded).toEqual(["https://example.com/login"]);
        expect(win.isVisible()).toBe(true);
        expect(win.menuRemoved).toBe(true);
        expect(win.webContents.windowOpenHandler!({ url: "https://example.com/popup" })).toEqual({ action: "deny" });

        loggedIn = true;
        win.navigate("https://example.com/home");
        expect(await result).toBe(true);
        expect(seen.at(-1)).toBe("https://example.com/home");
        expect(win.isDestroyed()).toBe(true);
        expect(electron.sessions.get("persist:t-kit-site")!.cookies.flushes).toBe(1);
        delete (globalThis as { mainWindowId?: number; }).mainWindowId;
    });

    test("asks done on a slow interval too, for a login that finishes without navigating", async () => {
        let loggedIn = false;
        const result = loginWindow(privateSession(ctx, "poll"), { url: "https://example.com", done: () => loggedIn, pollMs: 5 });
        await flush();
        loggedIn = true;
        expect(await result).toBe(true);
    });

    test("resolves false when the user closes it or the signal aborts, destroying the window and flushing cookies", async () => {
        const login = privateSession(ctx, "closing");
        const closed = loginWindow(login, { url: "https://example.com", done: () => false });
        electron.windows.at(-1)!.close();
        expect(await closed).toBe(false);

        const controller = new AbortController();
        const aborted = loginWindow(login, { url: "https://example.com", done: () => false, signal: controller.signal });
        const win = electron.windows.at(-1)!;
        controller.abort();
        expect(await aborted).toBe(false);
        expect(win.isDestroyed()).toBe(true);
        expect(electron.sessions.get("persist:t-kit-closing")!.cookies.flushes).toBe(2);
        expect(await loginWindow(login, { url: "https://example.com", done: () => true, signal: AbortSignal.abort() })).toBe(false);
    });

    test("a second call while one is open focuses it and returns the same promise", async () => {
        const login = privateSession(ctx, "once");
        const first = loginWindow(login, { url: "https://example.com", done: () => false });
        const win = electron.windows.at(-1)!;
        win.minimize();
        const second = loginWindow(login, { url: "https://example.com/other", done: () => true });
        expect(second).toBe(first);
        expect(electron.windows.at(-1)).toBe(win);
        expect(win.isMinimized()).toBe(false);
        expect(win.isFocused()).toBe(true);
        win.close();
        expect(await first).toBe(false);
        const third = loginWindow(login, { url: "https://example.com", done: () => false });
        expect(third).not.toBe(first);
        electron.windows.at(-1)!.close();
        await third;
    });

    test("only https pages: the start URL must be one, and navigations elsewhere are stopped", async () => {
        const login = privateSession(ctx, "https");
        expect(() => loginWindow(login, { url: "http://example.com", done: () => false })).toThrow(TypeError);
        const result = loginWindow(login, { url: "https://example.com", done: () => false });
        const win = electron.windows.at(-1)!;
        expect(win.navigate("http://example.com/plain")).toBe(false);
        expect(win.navigate("file:///etc/passwd")).toBe(false);
        expect(win.webContents.getURL()).toBe("https://example.com");
        expect(win.navigate("https://example.com/next")).toBe(true);
        win.close();
        await result;
    });

    test("a done that throws is asked again later instead of ending the login", async () => {
        let calls = 0;
        const result = loginWindow(privateSession(ctx, "throws"), {
            url: "https://example.com", pollMs: 60_000, done: () => {
                calls++;
                if (calls === 1) throw new Error("not yet");
                return true;
            },
        });
        await flush();
        electron.windows.at(-1)!.navigate("https://example.com/2");
        expect(await result).toBe(true);
    });
});

describe("fakeElectron", () => {
    test("windows: constructible, found by id and focus, closable unless prevented", async () => {
        const { BrowserWindow } = electron.module;
        const win = new BrowserWindow({ width: 300, title: "T" });
        expect(BrowserWindow.fromId(win.id)).toBe(win);
        expect(BrowserWindow.getFocusedWindow()).toBeNull();
        win.focus();
        expect(BrowserWindow.getFocusedWindow()).toBe(win);
        const events: string[] = [];
        win.webContents.on("did-navigate", (_e: unknown, url: string) => events.push(url));
        win.once("ready-to-show", () => events.push("ready"));
        await win.loadURL("https://example.com/");
        expect(events).toEqual(["https://example.com/", "ready"]);
        win.once("close", (e: { preventDefault(): void; }) => e.preventDefault());
        win.close();
        expect(win.isDestroyed()).toBe(false);
        win.on("closed", () => events.push("closed"));
        win.close();
        win.destroy();
        expect(events.filter(e => e === "closed")).toHaveLength(1);
        expect(BrowserWindow.getAllWindows()).toEqual([]);
        expect(BrowserWindow.getFocusedWindow()).toBeNull();
    });

    test("cookies: set, matched by URL, domain and secure, and changed events", async () => {
        const { cookies } = electron.module.session.fromPartition("persist:x");
        const changes: [string, boolean][] = [];
        cookies.on("changed", (_e: unknown, cookie: { name: string; }, _cause: string, removed: boolean) => changes.push([cookie.name, removed]));
        await cookies.set({ url: "https://a.example.com", name: "host", value: "1" });
        await cookies.set({ url: "https://example.com", domain: ".example.com", name: "wide", value: "2", secure: true });
        expect((await cookies.get({ url: "https://a.example.com" })).map(c => c.name)).toEqual(["host", "wide"]);
        expect((await cookies.get({ url: "https://b.example.com" })).map(c => c.name)).toEqual(["wide"]);
        expect(await cookies.get({ url: "http://b.example.com" })).toEqual([]);
        expect((await cookies.get({ domain: "example.com" })).map(c => c.name)).toEqual(["host", "wide"]);
        await cookies.remove("https://example.com", "wide");
        expect(changes).toEqual([["host", false], ["wide", false], ["wide", true]]);
        expect(electron.module.session.fromPartition("persist:x")).toBe(electron.sessions.get("persist:x")!);
    });

    test("dialogs answer what the test set and record their parent and options; app is an event emitter", async () => {
        electron.dialogAnswers.save = { canceled: false, filePath: "/tmp/out.json" };
        const parent = electron.addWindow();
        expect(await electron.module.dialog.showSaveDialog(parent, { title: "Save" })).toEqual({ canceled: false, filePath: "/tmp/out.json" });
        expect(await electron.module.dialog.showMessageBox({ message: "Sure?" })).toEqual({ response: 0, checkboxChecked: false });
        expect(electron.dialogCalls).toEqual([
            { kind: "save", parent, options: { title: "Save" } },
            { kind: "message", parent: null, options: { message: "Sure?" } },
        ]);
        let quit = 0;
        electron.module.app.once("will-quit", () => quit++);
        electron.module.app.emit("will-quit");
        expect(quit).toBe(1);
        expect(electron.module.app.getPath("userData")).toBe("/fake/userData");
    });
});

describe("openExternal", () => {
    test("opens an https link in the browser, and refuses anything else", async () => {
        await openExternal("https://example.com/docs");
        expect(electron.opened).toEqual(["https://example.com/docs"]);
        for (const bad of ["file:///C:/Windows/System32/calc.exe", "http://example.com", "ms-settings:", 42]) {
            await expect(openExternal(bad)).rejects.toMatchObject({ code: "bad-argument" });
        }
        await expect(openExternal("https://example.net", { hosts: ["example.com"] })).rejects.toMatchObject({ code: "bad-argument" });
        expect(electron.opened).toHaveLength(1);
    });
});
