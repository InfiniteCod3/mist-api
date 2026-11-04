/** The page side of a plugin's event channel: a long-poll loop behind `mist.events.subscribe`. */
import type { EventsAnswer } from "./protocol.ts";

export interface SubscribeOptions {
    /**
     * Loads the page's state. Runs before the first events, and again whenever the page has to load
     * its state again: the native side restarted, or the page fell behind its kept events. When it
     * throws or rejects, it runs again after `retryMs`.
     */
    onConnect?: () => unknown;
    /** How long to wait after a failed poll or onConnect before trying again. Default 2000 */
    retryMs?: number;
}

export interface MistEvents<E> {
    /**
     * Calls `listener` with each event from the native side, in order. Ends when the run is disposed,
     * or when the returned function is called. A native module without a channel takes no listener.
     */
    subscribe(listener: [E] extends [never] ? never : (event: E) => void, options?: SubscribeOptions): () => void;
}

export interface Subscription<E> {
    /** The run the subscription belongs to: it ends when the run is disposed */
    onDispose(fn: () => void): void;
    poll(boot: string | null, cursor: number): Promise<EventsAnswer<E>>;
    /** Logs a failure, once per distinct message */
    report(line: string, err: unknown): void;
}

export function subscribe<E>(run: Subscription<E>, listener: (event: E) => void, { onConnect, retryMs = 2000 }: SubscribeOptions = {}): () => void {
    let active = true;
    let cancelPause: (() => void) | undefined;
    const off = () => {
        active = false;
        cancelPause?.();
    };
    run.onDispose(off);

    const pause = () => new Promise<void>(resolve => {
        const done = () => {
            clearTimeout(timer);
            cancelPause = undefined;
            resolve();
        };
        const timer = setTimeout(done, retryMs);
        cancelPause = done;
    });

    void (async () => {
        let boot: string | null = null;
        let cursor = 0;
        while (active) {
            try {
                const answer = await run.poll(boot, cursor);
                if (!active) return;
                if (answer.fresh) {
                    await onConnect?.();
                    if (!active) return;
                }
                // Only once onConnect succeeded: a failed one is asked for again with a fresh poll
                boot = answer.boot;
                cursor = answer.cursor;
                for (const event of answer.events) {
                    if (!active) return;
                    try {
                        listener(event);
                    } catch (err) {
                        run.report("An event listener threw", err);
                    }
                }
            } catch (err) {
                if (!active) return;
                run.report("Couldn't get events from the native side; trying again", err);
                await pause();
            }
        }
    })();

    return off;
}
