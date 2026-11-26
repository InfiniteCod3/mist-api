import { checkDelay, checkNumber, MAX_TIMEOUT_MS } from "../internal.ts";

export interface BackoffOptions {
    /** The first delay. Default 1000 */
    baseMs?: number;
    /** No delay is longer. Default 30000, or baseMs when that is longer */
    maxMs?: number;
    /** Each delay is this many times the one before, up to maxMs. Default 2 */
    factor?: number;
    /** How much of each delay is random, from 0 (none) to 1 (anywhere from 0 to the delay). Default 0.2 */
    jitter?: number;
    /** A number from 0 up to 1. Default Math.random */
    random?: () => number;
}

export interface Backoff {
    /** The delay before the next try, in ms. Each call counts one more attempt. */
    next(): number;
    /** Starts again from baseMs, as after a success */
    reset(): void;
    /** How many delays `next` has given since the start or the last reset */
    readonly attempts: number;
}

/**
 * Delays between retries: baseMs, then factor times longer each attempt, never over maxMs. The last
 * `jitter` share of each delay is random: clients that failed together don't retry together.
 */
export function backoff({ baseMs = 1000, maxMs = Math.max(30_000, baseMs), factor = 2, jitter = 0.2, random = Math.random }: BackoffOptions = {}): Backoff {
    checkDelay("backoff", "baseMs", baseMs);
    checkNumber("backoff", "maxMs", maxMs, { min: baseMs, max: MAX_TIMEOUT_MS });
    checkNumber("backoff", "factor", factor, { min: 1 });
    checkNumber("backoff", "jitter", jitter, { min: 0, max: 1 });
    let attempts = 0;
    return {
        next() {
            const full = Math.min(maxMs, baseMs * factor ** attempts);
            attempts++;
            const r = random();
            return Math.round(full * (1 - jitter + jitter * (r >= 0 && r <= 1 ? r : 1)));
        },
        reset() {
            attempts = 0;
        },
        get attempts() {
            return attempts;
        },
    };
}
