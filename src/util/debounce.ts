import { checkDelay, shownValue } from "../internal.ts";

export interface DebounceOptions {
    /** Cancels the pending call when it aborts, and ignores calls after that */
    signal?: AbortSignal;
    /** Runs the pending call on abort instead of dropping it. Default false */
    flushOnAbort?: boolean;
}

export type Debounced<A extends unknown[]> = ((...args: A) => void) & {
    /** Runs the pending call now, if there is one */
    flush(): void;
    /** Drops the pending call */
    cancel(): void;
};

type Schedule = (run: () => void) => () => void;

const after = (ms: number): Schedule => run => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
};

/**
 * The next animation frame. A hidden page gets none until it shows again, and a page without frames
 * gets none at all: both wait 16ms, as does a frame asked for just before the page hid.
 */
const frame: Schedule = run => {
    const hasDocument = typeof document !== "undefined";
    if (typeof requestAnimationFrame !== "function" || hasDocument && document.hidden) return after(16)(run);
    let unschedule: () => void;
    const onVisibility = () => {
        if (!document.hidden) return;
        cancelAnimationFrame(id);
        document.removeEventListener("visibilitychange", onVisibility);
        unschedule = after(16)(run);
    };
    const id = requestAnimationFrame(() => {
        if (hasDocument) document.removeEventListener("visibilitychange", onVisibility);
        run();
    });
    if (hasDocument) document.addEventListener("visibilitychange", onVisibility);
    unschedule = () => {
        cancelAnimationFrame(id);
        if (hasDocument) document.removeEventListener("visibilitychange", onVisibility);
    };
    return () => unschedule();
};

/**
 * Calls `fn` once calls stop coming for `delay` ms, or on the next animation frame for "frame", with
 * the last call's arguments. The abort listener on `signal` is only there while a call is pending.
 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, delay: number | "frame", { signal, flushOnAbort = false }: DebounceOptions = {}): Debounced<A> {
    if (delay !== "frame" && typeof delay !== "number") throw new TypeError(`debounce: delay must be "frame" or a number, got ${shownValue(delay)}`);
    const schedule = delay === "frame" ? frame : after(checkDelay("debounce", "delay", delay));
    let pending: A | undefined;
    let unschedule: (() => void) | undefined;

    const onAbort = () => flushOnAbort ? flush() : cancel();
    const clear = () => {
        unschedule?.();
        unschedule = undefined;
        signal?.removeEventListener("abort", onAbort);
    };
    const flush = () => {
        const args = pending;
        clear();
        pending = undefined;
        if (args) fn(...args);
    };
    const cancel = () => {
        clear();
        pending = undefined;
    };

    const debounced = (...args: A) => {
        if (signal?.aborted) return;
        clear();
        pending = args;
        unschedule = schedule(flush);
        signal?.addEventListener("abort", onAbort, { once: true });
    };
    return Object.assign(debounced, { flush, cancel });
}
