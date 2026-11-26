/** Opening a login window in a private session, and links in the user's browser. */
import * as electron from "electron";
import type { BrowserWindow, Session } from "electron";

import { check } from "./check.ts";
import { checkNumber, checkTimeout, shownValue } from "./internal.ts";
import { log } from "./native-log.ts";
import { migrated, type PrivateSession } from "./session.ts";
import { discordWindow } from "./window.ts";

export interface LoginWindowOptions {
    /** The https page the window opens */
    url: string;
    /** Called with the page's URL on each navigation and every `pollMs`: true once the login is done */
    done(url: string): boolean | Promise<boolean>;
    /** Closes the window: the promise resolves false */
    signal?: AbortSignal;
    /** The window's title, which the page can't change. Default the page's title */
    title?: string;
    /** Default 480 */
    width?: number;
    /** Default 720 */
    height?: number;
    /** How often `done` is asked between navigations, in ms. Default 1000 */
    pollMs?: number;
}

const open = new WeakMap<Session, { win: BrowserWindow; done: Promise<boolean>; }>();

const isHttps = (url: string) => {
    try {
        return new URL(url).protocol === "https:";
    } catch {
        return false;
    }
};

/**
 * Opens `options.url` in a sandboxed window of the private session, centred over Discord's window:
 * no Node, no preload, context isolation, popups denied, and only https pages. Resolves true once
 * `options.done` answers true, false when the user closes the window or `options.signal` aborts. The
 * window is destroyed and the cookies flushed before it resolves. While one is open for the session,
 * another call focuses it and returns its promise.
 */
export function loginWindow(ses: PrivateSession | Session, options: LoginWindowOptions): Promise<boolean> {
    const session = "partition" in ses ? ses.session : ses;
    const { url, done, signal, title, width = 480, height = 720, pollMs = 1000 } = options;
    if (!isHttps(url)) throw new TypeError(`loginWindow: url must be an https page, got ${shownValue(url)}`);
    if (typeof done !== "function") throw new TypeError("loginWindow: options.done must be a function that answers true once the login is done");
    checkNumber("loginWindow", "width", width, { min: 1, integer: true });
    checkNumber("loginWindow", "height", height, { min: 1, integer: true });
    checkTimeout("loginWindow", "pollMs", pollMs);

    const known = open.get(session);
    if (known && !known.win.isDestroyed()) {
        if (known.win.isMinimized()) known.win.restore();
        known.win.focus();
        return known.done;
    }
    if (signal?.aborted) return Promise.resolve(false);

    const parent = discordWindow();
    const at = parent?.getBounds();
    const win = new electron.BrowserWindow({
        width, height, show: false, parent, title, autoHideMenuBar: true,
        ...at ? { x: Math.round(at.x + (at.width - width) / 2), y: Math.round(at.y + Math.max(0, (at.height - height) / 2)) } : { center: true },
        webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
    });
    win.removeMenu();
    if (title) win.on("page-title-updated", event => event.preventDefault());
    win.once("ready-to-show", () => win.show());
    const contents = win.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    const httpsOnly = (event: { url: string; preventDefault(): void; }) => {
        if (!isHttps(event.url)) event.preventDefault();
    };
    contents.on("will-navigate", httpsOnly);
    contents.on("will-redirect", httpsOnly);

    const finished = new Promise<boolean>(resolve => {
        let settled = false, asking = false, again = false, logged = false;
        const finish = async (ok: boolean) => {
            if (settled) return;
            settled = true;
            clearInterval(timer);
            signal?.removeEventListener("abort", onAbort);
            if (open.get(session)?.win === win) open.delete(session);
            if (!win.isDestroyed()) win.destroy();
            await session.cookies.flushStore().catch(() => { });
            resolve(ok);
        };
        // A navigation while `done` is still answering asks again after it: the last page is never missed
        const ask = async () => {
            if (settled) return;
            if (asking) return void (again = true);
            asking = true;
            try {
                do {
                    again = false;
                    if (win.isDestroyed()) return;
                    if (await done(contents.getURL())) return void finish(true);
                } while (again && !settled);
            } catch (err) {
                // Asked again at the next navigation or poll; logged once, as it may throw on every page
                if (!logged) log.error("loginWindow's done threw:", err);
                logged = true;
            } finally {
                asking = false;
            }
        };
        const onAbort = () => void finish(false);
        const timer = setInterval(() => void ask(), pollMs);
        contents.on("did-navigate", () => void ask());
        contents.on("did-navigate-in-page", () => void ask());
        win.on("closed", () => void finish(false));
        signal?.addEventListener("abort", onAbort, { once: true });
    });
    open.set(session, { win, done: finished });
    migrated(session).then(() => win.isDestroyed() ? undefined : win.loadURL(url)).catch(() => { });
    return finished;
}

export interface OpenExternalOptions {
    /** Hosts the link may have, as `check.https` takes them. Default any host */
    hosts?: readonly string[];
}

/**
 * Opens an https link in the user's browser with Electron's shell. Anything else, or a host outside
 * `hosts`, throws a NativeError "bad-argument": a link from the page can't open a program or file.
 */
export async function openExternal(url: unknown, { hosts }: OpenExternalOptions = {}): Promise<void> {
    await electron.shell.openExternal(check.https(url, { hosts, name: "url" }).href);
}
