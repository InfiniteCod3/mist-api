import { begin, checkDelay, checkTimeout } from "../internal.ts";
import { sleep } from "./sleep.ts";

type Work<T> = Promise<T> | ((signal: AbortSignal) => Promise<T>);

/** Races `work` against `ms` (none when undefined) and `signal`. `expired` makes the reason a timeout rejects with. */
function race<T>(work: Work<T>, ms: number | undefined, signal: AbortSignal | undefined, expired: () => unknown): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const inner = new AbortController();
    return new Promise<T>((resolve, reject) => {
        const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };
        const fail = (reason: unknown) => {
            done();
            inner.abort(reason);
            reject(reason);
        };
        const onAbort = () => fail(signal!.reason);
        const timer = ms === undefined ? undefined : setTimeout(() => fail(expired()), ms);
        signal?.addEventListener("abort", onAbort, { once: true });
        const pending = typeof work === "function" ? begin(() => work(inner.signal)) : work;
        pending.then(resolve, reject).finally(done);
    });
}

/**
 * Settles as `work` does, or rejects with a TimeoutError DOMException after `ms`, or with the
 * signal's reason when it aborts first. A function `work` gets a signal that aborts on either. The
 * signal comes bare or as `{ signal }`.
 */
export function withTimeout<T>(work: Work<T>, ms: number, options?: AbortSignal | { signal?: AbortSignal; }): Promise<T> {
    try {
        checkDelay("withTimeout", "ms", ms);
    } catch (err) {
        return Promise.reject(err);
    }
    const signal = options instanceof AbortSignal ? options : options?.signal;
    return race(work, ms, signal, () => new DOMException(`Timed out after ${ms}ms`, "TimeoutError"));
}

export interface UntilOptions {
    /** Gives up after this many ms, resolving false. Without it, only `signal` ends the wait. */
    timeout?: number;
    /** The wait between checks, in ms. Default 50 */
    every?: number;
    /** Rejects with its reason when it aborts. Required without `timeout`. */
    signal?: AbortSignal;
}

/**
 * Calls `check` until it returns true (resolving true) or `timeout` passes (resolving false). Takes
 * `timeout`, `signal` or both, so it never waits forever. A TimeoutError that `check` or `signal`
 * throws rejects like any other error.
 */
export async function until(check: () => boolean | Promise<boolean>, { timeout, every = 50, signal }: UntilOptions = {}): Promise<boolean> {
    if (timeout === undefined && !signal) throw new TypeError("until: pass timeout, signal or both, or it could wait forever");
    if (timeout !== undefined) checkDelay("until", "timeout", timeout);
    checkTimeout("until", "every", every);
    const poll = async (inner: AbortSignal) => {
        for (; ;) {
            if (await check()) return true;
            inner.throwIfAborted();
            await sleep(every, inner);
        }
    };
    // Only this instance means the time ran out: a TimeoutError from `check` or `signal` is theirs
    const expired = new DOMException(`until: timed out after ${timeout}ms`, "TimeoutError");
    try {
        return await race(poll, timeout, signal, () => expired);
    } catch (err) {
        if (err === expired) return false;
        throw err;
    }
}
