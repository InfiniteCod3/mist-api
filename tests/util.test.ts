import { describe, expect, test } from "bun:test";

import { backoff, keepConnected, limit, parseSse, shared, sharedByKey, sseEvents, ttlCache } from "../src/util";

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

    test("bad options throw a TypeError", () => {
        expect(() => backoff({ jitter: 2 })).toThrow(TypeError);
        expect(() => backoff({ baseMs: -1 })).toThrow(TypeError);
        expect(() => backoff({ baseMs: 10, maxMs: 5 })).toThrow(TypeError);
        expect(() => backoff({ factor: 0.5 })).toThrow(TypeError);
        expect(() => backoff({ maxMs: Infinity })).toThrow(TypeError);
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

    test("bad options throw a TypeError", () => {
        expect(() => ttlCache({ ttlMs: NaN })).toThrow(TypeError);
        expect(() => ttlCache({ ttlMs: 1, max: 0 })).toThrow(TypeError);
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
        expect(() => limit(0)).toThrow(TypeError);
        expect(() => limit(1.5)).toThrow(TypeError);
    });
});
