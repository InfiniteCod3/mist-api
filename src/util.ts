/** `@aurologic/mist-api/util`: small helpers that work on the page and on the native side. */

/** A plain object or class instance, not null and not an array */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** Resolves after `ms`; rejects with the signal's reason if it aborts first */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal!.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export interface TimedInit extends RequestInit {
    /** Abort after this many ms. Default 10000 */
    timeout?: number;
}

/** fetch that gives up after `timeout` ms, on top of any signal passed in */
export function fetchWithTimeout(url: string | URL, { timeout = 10_000, signal, ...init }: TimedInit = {}): Promise<Response> {
    const timer = AbortSignal.timeout(timeout);
    return fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timer]) : timer });
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
 * A type for reading the bridge: `(window as WithDiscordNative).DiscordNative?.clipboard`. Types only, no
 * accessor function: Evi's store review finds desktop-bridge use by the literal `DiscordNative.x` in the
 * plugin's code, and a helper would hide it from reviewers.
 */
export type WithDiscordNative = { DiscordNative?: DiscordNativeBridge; };
