/** A login of the plugin's own, in an Electron session kept apart from Discord's. */
import type { NativeContext } from "@evi/api/native";
// A namespace import: a plugin's tests can mock electron with only the parts they use, and a named
// import of a part the mock lacks would fail to link before any of mist runs
import * as electron from "electron";
import type { Session } from "electron";

import { HttpError, type TimedInit } from "./util.ts";

export interface PrivateSessionOptions {
    /** Takes the Electron and Discord product tokens out of the user agent, for sites that refuse Electron. Default false */
    browserUserAgent?: boolean;
}

export interface PrivateSession {
    /** Electron's session, for what the helpers don't cover */
    readonly session: Session;
    /** `persist:<plugin id>-<name>` */
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
 * A session on the partition `persist:<plugin id>-<name>`, kept on disk, so a login made in it lasts
 * across restarts and Discord's cookies never reach the site. Every permission request and check from
 * its pages is denied. Calling it again for the same name gives the same session.
 */
export function privateSession(ctx: NativeContext, name: string, { browserUserAgent = false }: PrivateSessionOptions = {}): PrivateSession {
    if (typeof name !== "string" || !NAME.test(name)) throw new TypeError(`A private session's name is 1 to 40 lowercase letters, digits and -, got ${JSON.stringify(name)}`);
    const partition = `persist:${ctx.pluginId}-${name}`;
    const session = electron.session.fromPartition(partition);
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    if (browserUserAgent) session.setUserAgent(session.getUserAgent().replace(/\s(?:Electron|discord)\/\S+/gi, ""));

    const cookie = async (url: string, cookieName: string) => (await session.cookies.get({ url, name: cookieName }))[0]?.value;
    return {
        session,
        partition,
        fetch: (url, init) => session.fetch(String(url), init),
        async json(url, { timeout = 10_000, signal, ...init } = {}) {
            const timer = AbortSignal.timeout(timeout);
            const res = await session.fetch(String(url), { ...init, signal: signal ? AbortSignal.any([signal, timer]) : timer });
            if (!res.ok) throw new HttpError(res.status);
            return res.json();
        },
        cookie,
        hasCookie: async (url, cookieName) => await cookie(url, cookieName) !== undefined,
        async clear() {
            await session.clearStorageData();
            await session.clearCache();
        },
        flush: () => session.cookies.flushStore(),
    };
}
