/** The native side of a plugin's event channel. Evi's native side can't push to the page, so the page long-polls a hidden method. */
import type { EventsAnswer } from "./protocol.ts";

export interface NativeEventsOptions<E> {
    /** How many events are kept for a page that polls late. Default 1000 */
    keep?: number;
    /** Which events a page that just connected gets from before it connected. Default none */
    replay?: (event: E) => boolean;
    /** Checked each time an event is handed out: an event it rejects is left out of the answer */
    live?: (event: E) => boolean;
    /** How long a poll waits for an event before it answers empty. Default 25000 */
    waitMs?: number;
}

/** A channel from the native side to the page. Pass it to defineNative as `events`. */
export interface NativeEvents<E> {
    push(event: E): void;
}

/** What defineNative drives: the hidden poll, and the module's start and stop */
export interface EventChannel<E> {
    poll(boot: unknown, cursor: unknown): Promise<EventsAnswer<E>>;
    start(): void;
    stop(): void;
}

const channels = new WeakMap<object, EventChannel<unknown>>();

/** The channel behind `events`, or undefined when `events` didn't come from nativeEvents */
export const channelOf = <E>(events: NativeEvents<E>) => channels.get(events) as EventChannel<E> | undefined;

/**
 * Makes an event channel. Every pushed event gets the next sequence number and the last `keep` are
 * kept. Each run of the native side has its own boot id: a start after a stop begins an empty log
 * under a new id, so a page polling with the old id loads its state again.
 */
export function nativeEvents<E>(options: NativeEventsOptions<E> = {}): NativeEvents<E> {
    const { keep = 1000, replay = () => false, live = () => true, waitMs = 25_000 } = options;
    if (!Number.isInteger(keep) || keep < 1) throw new RangeError(`keep must be a positive integer, got ${keep}`);
    if (!(waitMs >= 0)) throw new RangeError(`waitMs must be 0 or more, got ${waitMs}`);

    let boot = crypto.randomUUID();
    let seq = 0;
    let log: { seq: number; event: E; }[] = [];
    let stopped = false;
    const waiters = new Set<() => void>();
    const wakeAll = () => { for (const wake of [...waiters]) wake(); };

    /** Where a page's poll continues from, or null when the page has to load its state again */
    function position(pageBoot: unknown, cursor: unknown): number | null {
        if (pageBoot !== boot || typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > seq) return null;
        // Events after the cursor were dropped to stay under `keep`
        if (log.length && cursor + 1 < log[0].seq) return null;
        return cursor;
    }

    function answer(from: number | null): EventsAnswer<E> {
        const kept = from === null ? log.filter(e => replay(e.event)) : log.filter(e => e.seq > from);
        return { boot, cursor: seq, fresh: from === null, events: kept.filter(e => live(e.event)).map(e => e.event) };
    }

    const events: NativeEvents<E> = {
        push(event) {
            log.push({ seq: ++seq, event });
            if (log.length > keep) log.splice(0, log.length - keep);
            wakeAll();
        },
    };

    channels.set(events, {
        async poll(pageBoot, cursor) {
            if (stopped) throw new Error("The native side is stopped");
            let from = position(pageBoot, cursor);
            if (from !== null && from === seq && waitMs > 0) {
                await new Promise<void>(resolve => {
                    const wake = () => {
                        clearTimeout(timer);
                        waiters.delete(wake);
                        resolve();
                    };
                    const timer = setTimeout(wake, waitMs);
                    waiters.add(wake);
                });
                from = position(pageBoot, from);
            }
            return answer(from);
        },
        start() {
            if (!stopped) return;
            stopped = false;
            boot = crypto.randomUUID();
            seq = 0;
            log = [];
        },
        stop() {
            stopped = true;
            wakeAll();
        },
    } satisfies EventChannel<E> as EventChannel<unknown>);

    return events;
}
