import { type Backoff, backoff, type BackoffOptions } from "./backoff.ts";
import { sleep as realSleep } from "./sleep.ts";

export interface KeepConnectedOptions {
    /** Ends the loop: aborts the connection under way and any wait */
    signal: AbortSignal;
    /** The delays between connections: options for `backoff`, or a Backoff of your own. Default `backoff()` */
    backoff?: BackoffOptions | Backoff;
    /** Called with each error `connect` throws, and the attempt it was since the last healthy connection, from 1 */
    onError?(err: unknown, attempt: number): void;
    /** Waits between connections. Default util's `sleep` */
    sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

const isBackoff = (value: BackoffOptions | Backoff): value is Backoff => typeof (value as Backoff).next === "function";

/**
 * Keeps a connection up until `options.signal` aborts: calls `connect(signal, connected)`, and when it
 * settles, waits the next backoff delay and calls it again. `connect` calls `connected()` once the
 * connection works, which resets the backoff. Every run is followed by a delay, so a `connect` that
 * returns at once doesn't spin. Resolves when the signal aborts, and never rejects for a connection error.
 */
export async function keepConnected(
    connect: (signal: AbortSignal, connected: () => void) => Promise<unknown> | unknown,
    { signal, backoff: delays = {}, onError, sleep = realSleep }: KeepConnectedOptions,
): Promise<void> {
    if (!(signal instanceof AbortSignal)) throw new TypeError("keepConnected needs options.signal, an AbortSignal that ends it");
    const retry = isBackoff(delays) ? delays : backoff(delays);
    const connected = () => retry.reset();
    while (!signal.aborted) {
        try {
            await connect(signal, connected);
        } catch (err) {
            if (signal.aborted) break;
            try { onError?.(err, retry.attempts + 1); } catch { }
        }
        if (signal.aborted) break;
        try {
            await sleep(retry.next(), signal);
        } catch {
            break;
        }
    }
}
