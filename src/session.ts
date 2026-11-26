/** A login for the plugin, in an Electron session kept apart from Discord's. */
import type { NativeContext } from "@evi/api/native";
import * as electron from "electron";
import type { Cookie, CookiesSetDetails, Session } from "electron";

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { dataFolder } from "./files.ts";
import { shownValue } from "./internal.ts";
import { log } from "./native-log.ts";
import { fetchJson, type TimedInit } from "./util.ts";

export interface PrivateSessionOptions {
    /** Takes the Electron and Discord product tokens out of the user agent, for sites that refuse Electron. Default false */
    browserUserAgent?: boolean;
}

export interface PrivateSession {
    /** Electron's session, for what the helpers don't cover */
    readonly session: Session;
    /** `persist:mist:<plugin id>:<name>` */
    readonly partition: string;
    /** Electron's `session.fetch`: sends and stores this session's cookies, not Discord's */
    fetch(url: string | URL, init?: RequestInit): Promise<Response>;
    /** The parsed JSON body of a 2xx answer, or an HttpError. `timeout` defaults to 10000 ms. */
    json(url: string | URL, init?: TimedInit): Promise<unknown>;
    /** The value of the cookie `name` that would be sent to `url`, or undefined */
    cookie(url: string, name: string): Promise<string | undefined>;
    hasCookie(url: string, name: string): Promise<boolean>;
    /** Signs out of everything: removes the session's cookies, storage and cache */
    clear(): Promise<void>;
    /** Writes the cookies to disk now. Electron otherwise writes them some time later, and a crash loses them. */
    flush(): Promise<void>;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Before 0.5 the partition was `persist:<plugin id>-<name>`, which two plugins could share (`a` with
 * `b-c`, `a-b` with `c`). `partition` is undefined when another installed plugin's id could make the
 * same name: that partition may hold the other plugin's login and is left alone.
 */
interface Legacy {
    readonly partition: string | undefined;
    /** The file that records the move as done, in the plugin's data folder; undefined without one */
    readonly marker: string | undefined;
}

/** Each session's legacy partition and its move of cookies, which the helpers and loginWindow wait for */
const migrations = new WeakMap<Session, { legacy: Legacy; done: Promise<void>; }>();

/** Resolves once `session`'s old cookies, if any, have moved in. Never rejects. */
export const migrated = (session: Session) => migrations.get(session)?.done ?? Promise.resolve();

const cookieUrl = (cookie: Cookie) => `${cookie.secure ? "https" : "http"}://${(cookie.domain ?? "").replace(/^\./, "")}${cookie.path ?? "/"}`;

/** The folder names under Evi's plugin folders and the plugin data folder: the ids of other plugins */
function pluginFolders(ctx: NativeContext): Set<string> {
    const roots = [join(ctx.dataDir, "plugins"), join(ctx.dataDir, "plugin-data"), dirname(ctx.pluginDir)].filter(dir => isAbsolute(dir));
    const names = new Set<string>();
    for (const root of new Set(roots)) {
        try {
            for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) names.add(entry.name);
        } catch { }
    }
    return names;
}

function legacyOf(ctx: NativeContext, name: string): Legacy & { clash?: string; } {
    const joined = `${ctx.pluginId}-${name}`;
    // Another plugin `other` made `persist:<other>-<its name>`, which is this one when `joined` starts with `<other>-`
    const clash = [...pluginFolders(ctx)].find(other => other !== ctx.pluginId && joined.startsWith(`${other}-`));
    let marker: string | undefined;
    try {
        if (isAbsolute(ctx.dataDir)) marker = join(dataFolder(ctx), `mist-session-${name}.migrated`);
    } catch { }
    return { partition: clash ? undefined : `persist:${joined}`, marker, clash };
}

function markMigrated(legacy: Legacy) {
    if (!legacy.marker) return;
    try {
        writeFileSync(legacy.marker, "");
    } catch (err) {
        log.warn(`privateSession: couldn't write ${legacy.marker}`, err);
    }
}

/**
 * Moves the legacy partition's cookies into `session` when it has none yet, removing them from the
 * old one so a later sign-out stays signed out. Runs once: the marker file then skips it. A cookie that
 * fails to move is logged and skipped.
 */
async function moveLegacyCookies(session: Session, legacy: Legacy & { clash?: string; }, name: string) {
    if (legacy.marker && existsSync(legacy.marker)) return;
    if (!legacy.partition) {
        log.warn(`privateSession: didn't move the cookies of the pre-0.5 session ${name}: the plugin ${legacy.clash} could have made the same partition. Sign in again.`);
        return markMigrated(legacy);
    }
    try {
        if (!(await session.cookies.get({})).length) {
            const old = electron.session.fromPartition(legacy.partition);
            let moved = 0;
            for (const cookie of await old.cookies.get({})) {
                const url = cookieUrl(cookie);
                const details: CookiesSetDetails = {
                    url,
                    name: cookie.name,
                    value: cookie.value,
                    path: cookie.path,
                    secure: cookie.secure,
                    httpOnly: cookie.httpOnly,
                    ...!cookie.hostOnly && { domain: cookie.domain },
                    ...cookie.expirationDate !== undefined && { expirationDate: cookie.expirationDate },
                    ...cookie.sameSite && { sameSite: cookie.sameSite },
                };
                try {
                    await session.cookies.set(details);
                } catch (err) {
                    log.warn(`privateSession: skipped the cookie ${cookie.name} of ${url}`, err);
                    continue;
                }
                moved++;
                try {
                    await old.cookies.remove(url, cookie.name);
                } catch (err) {
                    log.warn(`privateSession: couldn't remove the cookie ${cookie.name} of ${url} from ${legacy.partition}`, err);
                }
            }
            if (moved) {
                await Promise.all([session.cookies.flushStore(), old.cookies.flushStore()]);
                log.info(`privateSession: moved ${moved} cookies from ${legacy.partition}`);
            }
        }
        markMigrated(legacy);
    } catch (err) {
        log.warn(`privateSession: couldn't move the cookies of ${legacy.partition}. The login there may need doing again.`, err);
    }
}

/**
 * A session on the partition `persist:mist:<plugin id>:<name>`, kept on disk: a login made in it
 * lasts across restarts and Discord's cookies never reach the site. Every permission request and
 * check from its pages is denied. Calling it again for the same name gives the same session.
 */
export function privateSession(ctx: NativeContext, name: string, { browserUserAgent = false }: PrivateSessionOptions = {}): PrivateSession {
    if (typeof name !== "string" || !NAME.test(name)) throw new TypeError(`privateSession: name must be 1 to 40 lowercase letters, digits and -, got ${shownValue(name)}`);
    const partition = `persist:mist:${ctx.pluginId}:${name}`;
    const session = electron.session.fromPartition(partition);
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    if (browserUserAgent) session.setUserAgent(session.getUserAgent().replace(/\s(?:Electron|discord)\/\S+/gi, ""));
    let migration = migrations.get(session);
    if (!migration) {
        const legacy = legacyOf(ctx, name);
        migrations.set(session, migration = { legacy, done: moveLegacyCookies(session, legacy, name) });
    }
    const { legacy, done: ready } = migration;

    const cookie = async (url: string, cookieName: string) => {
        await ready;
        return (await session.cookies.get({ url, name: cookieName }))[0]?.value;
    };
    return {
        session,
        partition,
        async fetch(url, init) {
            await ready;
            return session.fetch(String(url), init);
        },
        async json(url, init) {
            await ready;
            return fetchJson(url, { ...init, fetch: session.fetch.bind(session) });
        },
        cookie,
        hasCookie: async (url, cookieName) => await cookie(url, cookieName) !== undefined,
        async clear() {
            await ready;
            await session.clearStorageData();
            await session.clearCache();
            // Cookies left in the pre-0.5 partition would otherwise sign the user back in on a later move
            if (legacy.partition) await electron.session.fromPartition(legacy.partition).clearStorageData();
            markMigrated(legacy);
        },
        async flush() {
            await ready;
            await session.cookies.flushStore();
        },
    };
}
