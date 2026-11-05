/** Finding Discord's main window from native code. */
// A namespace import: a plugin's tests can mock electron with only the parts they use, and a named
// import of a part the mock lacks would fail to link before any of mist runs
import * as electron from "electron";
import type { BrowserWindow } from "electron";

const APP_HOSTS = ["discord.com", "ptb.discord.com", "canary.discord.com"];

/** Discord's app page, not the splash screen, the in-game overlay or a popout */
function isAppWindow(win: BrowserWindow) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return false;
    try {
        const url = new URL(win.webContents.getURL());
        return url.protocol === "https:" && APP_HOSTS.includes(url.hostname) && !/^\/(overlay|popout)(\/|$)/.test(url.pathname);
    } catch {
        return false;
    }
}

/**
 * Discord's main window, or undefined while it doesn't exist (before Discord opens it, or after
 * it's gone). Discord's desktop core sets `global.mainWindowId`; when that window is missing or
 * isn't the app, the first window showing Discord's app page is used.
 */
export function discordWindow(): BrowserWindow | undefined {
    const id = (globalThis as { mainWindowId?: unknown; }).mainWindowId;
    const main = typeof id === "number" ? electron.BrowserWindow.fromId(id) : null;
    if (main && isAppWindow(main)) return main;
    return electron.BrowserWindow.getAllWindows().find(isAppWindow);
}
