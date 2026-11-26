/** `@aurologic/mist-api/util`: small helpers that work on the page and on the native side. */
import { begin, checkDelay } from "./internal.ts";

export { type Backoff, backoff, type BackoffOptions } from "./util/backoff.ts";
export { debounce, type Debounced, type DebounceOptions } from "./util/debounce.ts";
export { keepConnected, type KeepConnectedOptions } from "./util/keep-connected.ts";
export { limit } from "./util/limit.ts";
export { shared, sharedByKey } from "./util/shared.ts";
export { sleep } from "./util/sleep.ts";
export { parseSse, type SseEvent, sseEvents } from "./util/sse.ts";
export { until, type UntilOptions, withTimeout } from "./util/timeout.ts";
export { type TtlCache, ttlCache, type TtlCacheOptions } from "./util/ttl-cache.ts";

/** A plain object or class instance, not null and not an array */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** A Discord id: a string of 1 to 20 digits */
export const isSnowflake = (value: unknown): value is string =>
    typeof value === "string" && /^\d{1,20}$/.test(value);

export interface TimedInit extends RequestInit {
    /** Abort after this many ms. Default 10000 */
    timeout?: number;
    /** Sends the request in place of the global fetch, as an Electron session's `fetch` does. Called with the URL as a string. */
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** fetch that gives up after `timeout` ms, on top of any signal passed in */
export function fetchWithTimeout(url: string | URL, { timeout = 10_000, signal, fetch: send = globalThis.fetch, ...init }: TimedInit = {}): Promise<Response> {
    return begin(() => {
        const timer = AbortSignal.timeout(checkDelay("fetchWithTimeout", "timeout", timeout));
        return send(String(url), { ...init, signal: signal ? AbortSignal.any([signal, timer]) : timer });
    });
}

/** An HTTP answer that wasn't 2xx. `message` is "HTTP <status>", which callers can match on. */
export class HttpError extends Error {
    constructor(readonly status: number) {
        super(`HTTP ${status}`);
        this.name = "HttpError";
    }
}

/** The parsed JSON body of a 2xx answer. Untyped on purpose: validate it before use. */
export async function fetchJson(url: string | URL, init?: TimedInit): Promise<unknown> {
    const res = await fetchWithTimeout(url, init);
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
}

/** The parts of Discord's desktop bridge plugins use. Each may be missing: check before calling. */
export interface DiscordNativeBridge {
    window?: { focus?(): void; };
    clipboard?: { copy?(text: string): void; };
    fileManager?: { saveWithDialog?(data: Uint8Array, filename: string): Promise<string | undefined>; };
}

/**
 * A type for reading the bridge: `(window as WithDiscordNative).DiscordNative?.clipboard`. Types only:
 * Evi's store review finds desktop-bridge use by the literal `DiscordNative.x` in the plugin's code,
 * and an accessor function would hide it from reviewers.
 */
export type WithDiscordNative = { DiscordNative?: DiscordNativeBridge; };
