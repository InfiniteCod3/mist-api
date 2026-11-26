import { describe, expect, test } from "bun:test";

import { checkNumber, createLogOnce, globalSlot, MAX_TIMEOUT_MS, notifyEach } from "../src/internal";
import { backoff, debounce, fetchJson, fetchWithTimeout, HttpError, isSnowflake, keepConnected, limit, parseSse, shared, sharedByKey, sleep, sseEvents, ttlCache, until, withTimeout } from "../src/util";

/** A promise with its resolve and reject outside */
function deferred<T = void>() {
    let resolve!: (value: T) => void, reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe("shared", () => {
    test("callers during a run get the same promise, and the next call after it settles starts a new run", async () => {
        let runs = 0;
        const gate = deferred<number>();
        const load = shared(() => (runs++, gate.promise));
        const a = load(), b = load();
        expect(a).toBe(b);
        gate.resolve(7);
        expect(await a).toBe(7);
        expect(await b).toBe(7);
        expect(runs).toBe(1);
        await load();
        expect(runs).toBe(2);
    });

    test("a failed run rejects every caller and doesn't stick", async () => {
        let runs = 0;
        const load = shared(async () => {
            runs++;
            if (runs === 1) throw new Error("offline");
            return "ok";
        });
        const [a, b] = [load(), load()];
        await expect(a).rejects.toThrow("offline");
        await expect(b).rejects.toThrow("offline");
        expect(await load()).toBe("ok");
        expect(runs).toBe(2);
    });

    test("a function that throws synchronously rejects, and the next call runs it again", async () => {
        let runs = 0;
        const load = shared((): Promise<number> => {
            runs++;
            throw new Error("bad");
        });
        await expect(load()).rejects.toThrow("bad");
        await expect(load()).rejects.toThrow("bad");
        expect(runs).toBe(2);
    });

    test("the keyed form shares runs per key and runs different keys side by side", async () => {
        const calls: [string, number][] = [];
        const gates = { a: deferred<string>(), b: deferred<string>() };
        const read = sharedByKey((key: "a" | "b", n: number) => (calls.push([key, n]), gates[key].promise));
        const a1 = read("a", 1), a2 = read("a", 2), b1 = read("b", 3);
        expect(a1).toBe(a2);
        expect(a1).not.toBe(b1);
        expect(calls).toEqual([["a", 1], ["b", 3]]);
        gates.a.resolve("A");
        gates.b.resolve("B");
        expect(await Promise.all([a1, a2, b1])).toEqual(["A", "A", "B"]);
        gates.a = deferred<string>();
        const again = read("a", 4);
        expect(calls.at(-1)).toEqual(["a", 4]);
        gates.a.resolve("A2");
        expect(await again).toBe("A2");
    });
});

describe("backoff", () => {
    test("without jitter, delays grow by factor from baseMs and stop at maxMs", () => {
        const delays = backoff({ baseMs: 100, maxMs: 1000, factor: 3, jitter: 0 });
        expect([1, 2, 3, 4, 5].map(() => delays.next())).toEqual([100, 300, 900, 1000, 1000]);
        expect(delays.attempts).toBe(5);
    });

    test("the defaults are 1 s doubling to 30 s, and jitter takes up to its share off each delay", () => {
        const low = backoff({ random: () => 0 });
        const high = backoff({ random: () => 1 });
        expect([1, 2, 3, 4, 5, 6, 7].map(() => high.next())).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
        expect([1, 2].map(() => low.next())).toEqual([800, 1600]);
        expect(backoff({ jitter: 1, random: () => 0.5 }).next()).toBe(500);
    });

    test("reset starts again from baseMs", () => {
        const delays = backoff({ jitter: 0 });
        delays.next();
        delays.next();
        delays.reset();
        expect(delays.attempts).toBe(0);
        expect(delays.next()).toBe(1000);
    });

    test("a random function out of range counts as the full delay", () => {
        expect(backoff({ random: () => NaN }).next()).toBe(1000);
        expect(backoff({ random: () => 5 }).next()).toBe(1000);
    });

    test("bad options throw: a TypeError for a non-number, a RangeError for one out of range", () => {
        expect(() => backoff({ jitter: 2 })).toThrow(RangeError);
        expect(() => backoff({ baseMs: -1 })).toThrow(RangeError);
        expect(() => backoff({ baseMs: 10, maxMs: 5 })).toThrow(RangeError);
        expect(() => backoff({ factor: 0.5 })).toThrow(RangeError);
        expect(() => backoff({ maxMs: Infinity })).toThrow(RangeError);
        expect(() => backoff({ baseMs: "1" as never })).toThrow("backoff: baseMs must be a number");
    });
});

describe("keepConnected", () => {
    test("connects again after each end, waiting the backoff, until the signal aborts", async () => {
        const controller = new AbortController();
        const waits: number[] = [];
        let runs = 0;
        await keepConnected(() => {
            runs++;
            if (runs === 4) controller.abort();
        }, {
            signal: controller.signal,
            backoff: { jitter: 0 },
            sleep: async ms => void waits.push(ms),
        });
        expect(runs).toBe(4);
        expect(waits).toEqual([1000, 2000, 4000]);
    });

    test("connected() resets the backoff, so a healthy connection that drops waits baseMs again", async () => {
        const controller = new AbortController();
        const waits: number[] = [];
        let runs = 0;
        await keepConnected(async (_signal, connected) => {
            runs++;
            if (runs === 3) connected();
            if (runs === 5) controller.abort();
            throw new Error("dropped");
        }, { signal: controller.signal, backoff: { jitter: 0 }, sleep: async ms => void waits.push(ms) });
        expect(waits).toEqual([1000, 2000, 1000, 2000]);
    });

    test("reports each error with its attempt and never rejects for one", async () => {
        const controller = new AbortController();
        const errors: [string, number][] = [];
        let runs = 0;
        const done = keepConnected(async () => {
            runs++;
            if (runs === 3) controller.abort();
            throw new Error(`fail ${runs}`);
        }, {
            signal: controller.signal,
            onError: (err, attempt) => {
                errors.push([(err as Error).message, attempt]);
                throw new Error("a broken onError doesn't stop the loop");
            },
            sleep: async () => { },
        });
        await expect(done).resolves.toBeUndefined();
        expect(errors).toEqual([["fail 1", 1], ["fail 2", 2]]);
    });

    test("an abort during the wait ends it at once, and the connection gets the same signal", async () => {
        const controller = new AbortController();
        let seen: AbortSignal | undefined;
        const done = keepConnected(signal => void (seen = signal), { signal: controller.signal, backoff: { baseMs: 60_000 } });
        await flush();
        expect(seen).toBe(controller.signal);
        controller.abort();
        await done;
    });

    test("a connect that returns at once still waits between runs", async () => {
        const controller = new AbortController();
        let runs = 0;
        const done = keepConnected(() => void runs++, { signal: controller.signal, backoff: { baseMs: 50, jitter: 0 } });
        await flush();
        await flush();
        expect(runs).toBe(1);
        controller.abort();
        await done;
    });

    test("an aborted signal makes no connection, and a missing one throws", async () => {
        let runs = 0;
        await keepConnected(() => void runs++, { signal: AbortSignal.abort() });
        expect(runs).toBe(0);
        await expect(keepConnected(() => { }, {} as never)).rejects.toThrow(TypeError);
    });
});

/** A stream that hands out `chunks` one read at a time, and records a cancel */
function chunked(chunks: (string | Uint8Array)[]) {
    const state = { cancelled: false as unknown, reads: 0 };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            const next = chunks[state.reads++];
            if (next === undefined) return controller.close();
            controller.enqueue(typeof next === "string" ? encoder.encode(next) : next);
        },
        cancel(reason) {
            state.cancelled = reason ?? true;
        },
    }, { highWaterMark: 0 });
    return { stream, state };
}

async function collect<T>(events: AsyncIterable<T>) {
    const all: T[] = [];
    for await (const event of events) all.push(event);
    return all;
}

describe("server-sent events", () => {
    test("parseSse reads complete events and keeps the unfinished one as rest", () => {
        const { events, rest } = parseSse("event: song\ndata: {\"a\":1}\nid: 7\n\ndata: x\n\ndata: half");
        expect(events).toEqual([{ event: "song", data: "{\"a\":1}", id: "7" }, { event: "message", data: "x" }]);
        expect(rest).toBe("data: half");
    });

    test("joins data lines, skips comments and unknown fields, and drops events without data", () => {
        const { events } = parseSse(": keepalive\n\nretry: 5000\nfoo: bar\n\ndata: one\ndata:two\ndata\n\nevent: empty\n\n");
        expect(events).toEqual([{ event: "message", data: "one\ntwo\n" }]);
    });

    test("takes CRLF, LF and CR line ends, and holds a CR at the end that may be half a CRLF", () => {
        expect(parseSse("data: a\r\n\r\ndata: b\r\rdata: c\n\n").events.map(e => e.data)).toEqual(["a", "b", "c"]);
        const half = parseSse("data: a\r\n\r");
        expect(half.events).toEqual([]);
        expect(parseSse(`${half.rest}\n`).events).toEqual([{ event: "message", data: "a" }]);
    });

    test("strips one space after the colon only", () => {
        expect(parseSse("data:  two spaces\n\n").events[0].data).toBe(" two spaces");
    });

    test("sseEvents yields events across chunks, with UTF-8 split between them", async () => {
        const bytes = new TextEncoder().encode("data: café ☕\n\n");
        const cut = bytes.indexOf(0xc3) + 1;
        const { stream } = chunked(["event: hi\nda", "ta: 1\n", "\n", bytes.slice(0, cut), bytes.slice(cut), "data: lost at the end"]);
        expect(await collect(sseEvents(stream))).toEqual([{ event: "hi", data: "1" }, { event: "message", data: "café ☕" }]);
    });

    test("reads a Response's body", async () => {
        const res = new Response("data: a\n\ndata: b\n\n", { headers: { "content-type": "text/event-stream" } });
        expect((await collect(sseEvents(res))).map(e => e.data)).toEqual(["a", "b"]);
    });

    test("a final CR still ends the last event", async () => {
        const { stream } = chunked(["data: a\r\r"]);
        expect(await collect(sseEvents(stream))).toEqual([{ event: "message", data: "a" }]);
    });

    test("breaking out of the loop cancels the stream", async () => {
        const { stream, state } = chunked(["data: 1\n\n", "data: 2\n\n", "data: 3\n\n"]);
        for await (const event of sseEvents(stream)) if (event.data === "1") break;
        expect(state.cancelled).toBeTruthy();
        expect(state.reads).toBe(1);
    });

    test("an abort cancels the stream and throws the signal's reason", async () => {
        const controller = new AbortController();
        let pulled!: () => void;
        const stream = new ReadableStream<Uint8Array>({
            start(c) { c.enqueue(new TextEncoder().encode("data: 1\n\n")); },
            pull() { return new Promise<void>(resolve => { pulled = resolve; }); },
            cancel(reason) { cancelled = reason; },
        });
        let cancelled: unknown;
        const seen: string[] = [];
        const reading = (async () => {
            for await (const event of sseEvents(stream, controller.signal)) {
                seen.push(event.data);
                setTimeout(() => controller.abort(new Error("leaving")), 0);
            }
        })();
        await expect(reading).rejects.toThrow("leaving");
        expect(seen).toEqual(["1"]);
        expect(cancelled).toBeInstanceOf(Error);
        pulled?.();
    });

    test("an aborted signal cancels the stream before reading", async () => {
        const { stream, state } = chunked(["data: 1\n\n"]);
        await expect(collect(sseEvents(stream, AbortSignal.abort(new Error("gone"))))).rejects.toThrow("gone");
        expect(state.reads).toBe(0);
        expect(state.cancelled).toBeTruthy();
    });
});

describe("ttlCache", () => {
    test("an entry expires after ttlMs", () => {
        let now = 1000;
        const cache = ttlCache<string, number>({ ttlMs: 100, now: () => now });
        cache.set("a", 1);
        expect(cache.get("a")).toBe(1);
        now = 1099;
        expect(cache.has("a")).toBe(true);
        now = 1100;
        expect(cache.get("a")).toBeUndefined();
        expect(cache.has("a")).toBe(false);
        expect(cache.size).toBe(0);
    });

    test("ttlMs can depend on the value, and 0 or less keeps nothing", () => {
        let now = 0;
        const cache = ttlCache<string, { found: boolean; }>({ ttlMs: v => v.found ? 3_600_000 : 60_000, now: () => now });
        cache.set("hit", { found: true });
        cache.set("miss", { found: false });
        now = 60_000;
        expect(cache.has("miss")).toBe(false);
        expect(cache.has("hit")).toBe(true);
        const none = ttlCache<string, number>({ ttlMs: 0 });
        none.set("a", 1);
        expect(none.has("a")).toBe(false);
    });

    test("with max, setting one more evicts the least recently used", () => {
        const cache = ttlCache<string, number>({ ttlMs: Infinity, max: 2 });
        cache.set("a", 1);
        cache.set("b", 2);
        cache.get("a");
        cache.set("c", 3);
        expect([cache.has("a"), cache.has("b"), cache.has("c")]).toEqual([true, false, true]);
        cache.set("a", 10);
        cache.set("d", 4);
        expect(cache.get("a")).toBe(10);
        expect(cache.has("c")).toBe(false);
        expect(cache.size).toBe(2);
    });

    test("delete answers whether a live entry went, and clear empties it", () => {
        let now = 0;
        const cache = ttlCache<number, string>({ ttlMs: 10, now: () => now });
        cache.set(1, "a");
        cache.set(2, "b");
        expect(cache.delete(1)).toBe(true);
        expect(cache.delete(1)).toBe(false);
        now = 10;
        expect(cache.delete(2)).toBe(false);
        cache.set(3, "c");
        cache.clear();
        expect(cache.size).toBe(0);
    });

    test("bad options throw: a TypeError for a non-number, a RangeError for one out of range", () => {
        expect(() => ttlCache({ ttlMs: NaN })).toThrow(TypeError);
        expect(() => ttlCache({ ttlMs: 1, max: 0 })).toThrow(RangeError);
    });
});

describe("limit", () => {
    test("runs at most n at once, the rest in arrival order", async () => {
        const run = limit(2);
        const gates = [deferred(), deferred(), deferred(), deferred()];
        const started: number[] = [];
        const results = gates.map((gate, i) => run(async () => {
            started.push(i);
            await gate.promise;
            return i;
        }));
        await flush();
        expect(started).toEqual([0, 1]);
        gates[1].resolve();
        await flush();
        expect(started).toEqual([0, 1, 2]);
        gates[0].resolve();
        await flush();
        expect(started).toEqual([0, 1, 2, 3]);
        gates[2].resolve();
        gates[3].resolve();
        expect(await Promise.all(results)).toEqual([0, 1, 2, 3]);
    });

    test("a failure, sync or async, rejects its own call and frees its place", async () => {
        const run = limit(1);
        const sync = run((): Promise<number> => { throw new Error("sync"); });
        const async = run(async () => { throw new Error("async"); });
        const after = run(async () => "after");
        const [a, b, c] = await Promise.allSettled([sync, async, after]);
        expect(a).toMatchObject({ status: "rejected", reason: { message: "sync" } });
        expect(b).toMatchObject({ status: "rejected", reason: { message: "async" } });
        expect(c).toEqual({ status: "fulfilled", value: "after" });
    });

    test("n must be a whole number above 0", () => {
        expect(() => limit(0)).toThrow(RangeError);
        expect(() => limit(1.5)).toThrow("limit: n must be a whole number from 1, got 1.5");
        expect(() => limit("2" as never)).toThrow(TypeError);
    });
});

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Counts the abort listeners on `signal` that are still attached */
function countListeners(signal: AbortSignal) {
    const live = new Set<unknown>();
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, fn: unknown, ...rest: unknown[]) => {
        if (type === "abort") live.add(fn);
        return (add as (...args: unknown[]) => void)(type, fn, ...rest);
    }) as typeof add;
    signal.removeEventListener = ((type: string, fn: unknown, ...rest: unknown[]) => {
        if (type === "abort") live.delete(fn);
        return (remove as (...args: unknown[]) => void)(type, fn, ...rest);
    }) as typeof remove;
    return () => live.size;
}

// Timer margins are wide: Windows timers tick every 15.6ms, so a 5ms wait can take 16
describe("debounce", () => {
    test("calls once with the last arguments after calls stop for the delay", async () => {
        const calls: number[][] = [];
        const save = debounce((a: number, b: number) => void calls.push([a, b]), 80);
        save(1, 1);
        save(2, 2);
        await wait(10);
        save(3, 3);
        expect(calls).toEqual([]);
        await wait(200);
        expect(calls).toEqual([[3, 3]]);
    });

    test("flush runs the pending call now, once, and cancel drops it", async () => {
        const calls: string[] = [];
        const save = debounce((value: string) => void calls.push(value), 10);
        save("a");
        save.flush();
        save.flush();
        save("b");
        save.cancel();
        await wait(60);
        expect(calls).toEqual(["a"]);
    });

    test("a signal drops the pending call on abort, or runs it with flushOnAbort, and calls after it do nothing", async () => {
        const calls: string[] = [];
        const dropping = new AbortController();
        const drop = debounce((value: string) => void calls.push(`drop ${value}`), 10, { signal: dropping.signal });
        const flushing = new AbortController();
        const keep = debounce((value: string) => void calls.push(`keep ${value}`), 10, { signal: flushing.signal, flushOnAbort: true });
        drop("a");
        keep("a");
        dropping.abort();
        flushing.abort();
        drop("b");
        keep("b");
        await wait(60);
        expect(calls).toEqual(["keep a"]);
    });

    test("holds an abort listener on its signal only while a call is pending", async () => {
        const controller = new AbortController();
        const listeners = countListeners(controller.signal);
        // As a component makes one per render: none of them may leave a listener behind
        for (let i = 0; i < 20; i++) debounce(() => { }, 10, { signal: controller.signal });
        expect(listeners()).toBe(0);
        const save = debounce(() => { }, 10, { signal: controller.signal });
        save();
        save();
        expect(listeners()).toBe(1);
        save.cancel();
        expect(listeners()).toBe(0);
        save();
        save.flush();
        expect(listeners()).toBe(0);
        save();
        await wait(60);
        expect(listeners()).toBe(0);
    });

    test("\"frame\" waits for the next animation frame, or 16ms without one", async () => {
        const calls: number[] = [];
        const draw = debounce((n: number) => void calls.push(n), "frame");
        draw(1);
        draw(2);
        expect(calls).toEqual([]);
        await wait(80);
        expect(calls).toEqual([2]);
    });

    test("\"frame\" on a hidden page waits 16ms instead of a frame that won't come", async () => {
        const globals = globalThis as { requestAnimationFrame?: unknown; document?: unknown; };
        const saved = { raf: globals.requestAnimationFrame, document: globals.document };
        let frames = 0;
        globals.requestAnimationFrame = () => ++frames;
        globals.document = { hidden: true };
        try {
            const calls: number[] = [];
            debounce((n: number) => void calls.push(n), "frame")(1);
            await wait(80);
            expect(calls).toEqual([1]);
            expect(frames).toBe(0);
        } finally {
            globals.requestAnimationFrame = saved.raf;
            globals.document = saved.document;
        }
    });

    test("\"frame\" asked for just before the page hides waits 16ms instead, and leaves no visibility listener", async () => {
        const globals = globalThis as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown; document?: unknown; };
        const saved = { raf: globals.requestAnimationFrame, caf: globals.cancelAnimationFrame, document: globals.document };
        const frames = new Map<number, () => void>();
        let next = 0;
        globals.requestAnimationFrame = (run: () => void) => {
            frames.set(++next, run);
            return next;
        };
        globals.cancelAnimationFrame = (id: number) => void frames.delete(id);
        const listeners = new Set<() => void>();
        const doc = {
            hidden: false,
            addEventListener: (type: string, fn: () => void) => void (type === "visibilitychange" && listeners.add(fn)),
            removeEventListener: (type: string, fn: () => void) => void (type === "visibilitychange" && listeners.delete(fn)),
            dispatchEvent: () => void [...listeners].forEach(fn => fn()),
        };
        globals.document = doc;
        try {
            const calls: number[] = [];
            const draw = debounce((n: number) => void calls.push(n), "frame");
            draw(1);
            expect(frames.size).toBe(1);
            expect(listeners.size).toBe(1);
            // The page hides: the frame won't come, so the call moves to a 16ms timer
            doc.hidden = true;
            doc.dispatchEvent();
            expect(frames.size).toBe(0);
            expect(listeners.size).toBe(0);
            await wait(80);
            expect(calls).toEqual([1]);

            // A frame that comes removes the listener, and so does a cancel
            doc.hidden = false;
            draw(2);
            expect(listeners.size).toBe(1);
            [...frames.values()][0]!();
            expect(calls).toEqual([1, 2]);
            expect(listeners.size).toBe(0);
            draw(3);
            draw.cancel();
            expect(listeners.size).toBe(0);
            expect(frames.size).toBe(0);
            await wait(40);
            expect(calls).toEqual([1, 2]);
        } finally {
            globals.requestAnimationFrame = saved.raf;
            globals.cancelAnimationFrame = saved.caf;
            globals.document = saved.document;
        }
    });

    test("delay must be \"frame\" or a number from 0 to setTimeout's limit", () => {
        for (const delay of [NaN, "soon"]) expect(() => debounce(() => { }, delay as never)).toThrow(TypeError);
        for (const delay of [-1, Infinity, 3e9]) expect(() => debounce(() => { }, delay)).toThrow(RangeError);
        expect(() => debounce(() => { }, "soon" as never)).toThrow("debounce: delay must be \"frame\" or a number, got \"soon\"");
    });
});

describe("timer limits", () => {
    test("a delay over 2^31-1 ms, which setTimeout would run at once, is a RangeError", async () => {
        expect(MAX_TIMEOUT_MS).toBe(2 ** 31 - 1);
        await expect(sleep(3e9)).rejects.toThrow(RangeError);
        await expect(sleep(3e9)).rejects.toThrow(`sleep: ms must be a finite number from 0 to ${MAX_TIMEOUT_MS}, got 3000000000`);
        await expect(withTimeout(new Promise(() => { }), 3e9)).rejects.toThrow(RangeError);
        await expect(until(() => false, { timeout: 3e9 })).rejects.toThrow(RangeError);
        await expect(until(() => false, { timeout: 10, every: 3e9 })).rejects.toThrow(RangeError);
        expect(() => backoff({ maxMs: 3e9 })).toThrow(RangeError);
        await expect(fetchWithTimeout("https://example.com", { timeout: 3e9, fetch: async () => new Response() })).rejects.toThrow(RangeError);
        await expect(sleep(-1)).rejects.toThrow(RangeError);
        await expect(sleep(NaN)).rejects.toThrow(TypeError);
    });
});

describe("withTimeout", () => {
    test("settles as the work does when it is in time", async () => {
        expect(await withTimeout(Promise.resolve(3), 50)).toBe(3);
        await expect(withTimeout(Promise.reject(new Error("broke")), 50)).rejects.toThrow("broke");
        await expect(withTimeout(() => { throw new Error("sync"); }, 50)).rejects.toThrow("sync");
    });

    test("rejects with a TimeoutError and aborts the signal it gave the work", async () => {
        let inner: AbortSignal | undefined;
        const err = await withTimeout(signal => (inner = signal, new Promise<never>(() => { })), 5).catch((e: DOMException) => e);
        expect(err).toBeInstanceOf(DOMException);
        expect(err.name).toBe("TimeoutError");
        expect(inner!.aborted).toBe(true);
    });

    test("rejects with the outer signal's reason when it aborts first, or at once when it already has", async () => {
        const controller = new AbortController();
        const pending = withTimeout(new Promise(() => { }), 1000, controller.signal);
        controller.abort(new Error("left"));
        await expect(pending).rejects.toThrow("left");
        await expect(withTimeout(Promise.resolve(1), 1000, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    });

    test("takes the signal bare or as { signal }", async () => {
        await expect(withTimeout(Promise.resolve(1), 1000, { signal: AbortSignal.abort(new Error("wrapped")) })).rejects.toThrow("wrapped");
        expect(await withTimeout(Promise.resolve(2), 1000, {})).toBe(2);
    });

    test("removes its abort listener once settled", async () => {
        const controller = new AbortController();
        const listeners = countListeners(controller.signal);
        await withTimeout(Promise.resolve(1), 1000, controller.signal);
        await withTimeout(new Promise(() => { }), 1, controller.signal).catch(() => { });
        expect(listeners()).toBe(0);
    });

    test("ms must be a number from 0", async () => {
        await expect(withTimeout(Promise.resolve(1), NaN)).rejects.toThrow(TypeError);
        for (const ms of [-1, Infinity]) await expect(withTimeout(Promise.resolve(1), ms)).rejects.toThrow(RangeError);
    });
});

describe("until", () => {
    test("resolves true once the check passes, checking every `every` ms", async () => {
        let n = 0;
        expect(await until(() => ++n === 3, { timeout: 1000, every: 2 })).toBe(true);
        expect(n).toBe(3);
        expect(await until(async () => true, { timeout: 0 })).toBe(true);
    });

    test("resolves false when the timeout passes, even with a check still running", async () => {
        expect(await until(() => false, { timeout: 30, every: 2 })).toBe(false);
        expect(await until(() => new Promise<boolean>(() => { }), { timeout: 20 })).toBe(false);
    });

    test("rejects when the signal aborts, even with a TimeoutError as its reason", async () => {
        const controller = new AbortController();
        const pending = until(() => false, { timeout: 1000, signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        await expect(until(() => false, { timeout: 1000, signal: AbortSignal.abort(new DOMException("late", "TimeoutError")) })).rejects.toMatchObject({ name: "TimeoutError" });
    });

    test("a check that throws rejects with its error, a TimeoutError of its own included", async () => {
        await expect(until(() => { throw new Error("bad check"); }, { timeout: 100 })).rejects.toThrow("bad check");
        const own = new DOMException("the check's request timed out", "TimeoutError");
        await expect(until(() => { throw own; }, { timeout: 1000 })).rejects.toBe(own);
    });

    test("without a timeout, waits until the check passes or the signal aborts", async () => {
        let n = 0;
        expect(await until(() => ++n === 3, { every: 2, signal: new AbortController().signal })).toBe(true);
        const controller = new AbortController();
        const pending = until(() => new Promise<boolean>(() => { }), { signal: controller.signal });
        controller.abort(new Error("done waiting"));
        await expect(pending).rejects.toThrow("done waiting");
    });

    test("takes timeout, signal or both, and checks their values", async () => {
        await expect(until(() => true)).rejects.toThrow("until: pass timeout, signal or both");
        await expect(until(() => true, { every: 5 })).rejects.toThrow(TypeError);
        await expect(until(() => true, { timeout: -1 })).rejects.toThrow(RangeError);
        await expect(until(() => true, { timeout: 10, every: 0 })).rejects.toThrow("until: every must be a finite number above 0");
    });
});

test("isSnowflake takes strings of 1 to 20 digits only", () => {
    for (const id of ["1", "123456789012345678", "12345678901234567890"]) expect(isSnowflake(id)).toBe(true);
    for (const id of ["", "123456789012345678901", "12a", " 1", 123, null, undefined]) expect(isSnowflake(id)).toBe(false);
});

test("fetchWithTimeout and fetchJson send through a fetch passed in, with the URL as a string and the timeout's signal", async () => {
    const sent: { url: string; signal: AbortSignal | null | undefined; }[] = [];
    const send = async (url: string, init: RequestInit) => {
        sent.push({ url, signal: init.signal });
        return new Response(JSON.stringify({ ok: 1 }), { status: url.endsWith("missing") ? 404 : 200 });
    };
    expect(await fetchJson(new URL("https://example.com/a"), { fetch: send })).toEqual({ ok: 1 });
    await expect(fetchJson("https://example.com/missing", { fetch: send })).rejects.toBeInstanceOf(HttpError);
    expect((await fetchWithTimeout("https://example.com/b", { fetch: send, timeout: 50 })).status).toBe(200);
    expect(sent.map(s => s.url)).toEqual(["https://example.com/a", "https://example.com/missing", "https://example.com/b"]);
    expect(sent.every(s => s.signal instanceof AbortSignal)).toBe(true);
});

describe("internal helpers", () => {
    test("createLogOnce logs each distinct line and error once, then one notice past the cap", () => {
        const lines: unknown[][] = [];
        const log = createLogOnce((...args) => void lines.push(args), "mist.safe", 2);
        log("a threw", new Error("x"));
        log("a threw", new Error("x"));
        log("no error");
        log("b threw", new Error("y"));
        log("c threw", new Error("z"));
        expect(lines).toEqual([
            ["a threw", new Error("x")],
            ["no error"],
            ["mist.safe: 2 distinct errors logged; further errors suppressed"],
        ]);
    });

    test("notifyEach keeps calling listeners after one throws", () => {
        const heard: number[] = [];
        const errors: unknown[] = [];
        const broken = () => { throw new Error("broke"); };
        notifyEach<[number]>([n => void heard.push(n), broken, n => void heard.push(n * 2)], [3], (fn, err) => void errors.push([fn, err]));
        expect(heard).toEqual([3, 6]);
        expect(errors).toEqual([[broken, new Error("broke")]]);
    });

    test("checkNumber throws a TypeError for a non-number and a RangeError out of range", () => {
        expect(checkNumber("f", "n", 3, { min: 1, max: 5, integer: true })).toBe(3);
        expect(() => checkNumber("f", "n", "3")).toThrow("f: n must be a number, got \"3\"");
        expect(() => checkNumber("f", "n", NaN)).toThrow(TypeError);
        expect(() => checkNumber("f", "n", 0, { min: 0, exclusiveMin: true })).toThrow("f: n must be a finite number above 0, got 0");
        expect(() => checkNumber("f", "n", Infinity)).toThrow(RangeError);
        expect(() => checkNumber("f", "n", 6, { max: 5 })).toThrow("f: n must be a finite number up to 5, got 6");
    });

    test("globalSlot makes the value once, locks it, and refuses an incompatible one", () => {
        const root = {};
        const key = Symbol("slot");
        const valid = (value: unknown): value is { n: number; } => typeof (value as { n?: unknown; })?.n === "number";
        const first = globalSlot(key, () => ({ n: 1 }), valid, "test slot", root);
        expect(globalSlot(key, () => ({ n: 2 }), valid, "test slot", root)).toBe(first);
        expect(() => Object.defineProperty(root, key, { value: { n: 3 } })).toThrow();
        const taken = { [key]: "something else" };
        expect(() => globalSlot(key, () => ({ n: 1 }), valid, "test slot", taken)).toThrow("test slot was made by an incompatible copy of mist-api");
    });
});
