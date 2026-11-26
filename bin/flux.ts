/** mist flux: a watch on Discord's Flux dispatcher, kept in the page and drained by the CLI */
import { type Send, sleep, watchId } from "./cdp.ts";
import { type Limits, type PageError, type PageGlobal, pageCall, WATCH_TTL_MS } from "./page.ts";

export interface FluxRecord { type: string; at: number; payload: unknown; }
export interface FluxBatch { records: FluxRecord[]; dropped: number; alive: boolean; }

interface StartOptions {
    /** Action types to watch; empty watches every action */
    types: string[];
    /** The watch stops listening once it has kept this many, or never when null */
    limit: number | null;
    /** The watch removes itself when the CLI hasn't drained it for this long */
    ttlMs: number;
    limits: Limits;
}

type Action = { type: string; };
type Handler = (action: Action) => unknown;
interface Dispatcher {
    subscribe(type: string, fn: Handler): void;
    unsubscribe(type: string, fn: Handler): void;
    addInterceptor(fn: Handler): void;
    _interceptors?: Handler[];
}
interface FluxWatch { buffer: FluxRecord[]; dropped: number; kept: number; last: number; stop(): void; }
type FluxPage = PageGlobal<{ Evi: { api: { Dispatcher: Dispatcher; }; }; [watches: symbol]: Map<string, FluxWatch> | undefined; }>;

/**
 * Page side. Named types go through Dispatcher.subscribe; every action needs an interceptor, which
 * Discord's dispatcher calls before any handler and skips the action when it returns true. The
 * watch lives under a Symbol.for key so the CLI's next evaluate finds it.
 */
function start(snapshot: (value: unknown, limits: Limits) => unknown, id: string, options: StartOptions): PageError | null {
    const KEEP = 1000;
    const page = globalThis as FluxPage;
    const dispatcher = page.Evi.api.Dispatcher;
    const watches = page[Symbol.for("mist-cli.flux")] ??= new Map<string, FluxWatch>();
    const watch: FluxWatch = { buffer: [], dropped: 0, kept: 0, last: Date.now(), stop: () => { } };
    let remove: () => void;
    const record = (action: Action) => {
        if (options.limit !== null && watch.kept >= options.limit) return;
        try {
            const { type, ...payload } = action;
            watch.buffer.push({ type, at: Date.now(), payload: snapshot(payload, options.limits) });
            watch.kept++;
        } catch {
            watch.dropped++;
        }
        if (watch.buffer.length > KEEP) watch.dropped += watch.buffer.splice(0, watch.buffer.length - KEEP).length;
    };
    if (options.types.length) {
        for (const type of options.types) dispatcher.subscribe(type, record);
        remove = () => { for (const type of options.types) dispatcher.unsubscribe(type, record); };
    } else {
        const interceptors = dispatcher._interceptors;
        if (!Array.isArray(interceptors)) return { error: "mist can't watch every action: this Discord's dispatcher keeps no interceptor list. Name the action types." };
        const intercept = (action: Action) => {
            record(action);
            return false;
        };
        dispatcher.addInterceptor(intercept);
        remove = () => {
            const at = interceptors.indexOf(intercept);
            if (at >= 0) interceptors.splice(at, 1);
        };
    }
    const watchdog = setInterval(() => { if (Date.now() - watch.last > options.ttlMs) watch.stop(); }, Math.max(10, options.ttlMs / 4));
    watch.stop = () => {
        clearInterval(watchdog);
        remove();
        watches.delete(id);
    };
    watches.set(id, watch);
    return null;
}

function take(id: string): FluxBatch {
    const watch = (globalThis as FluxPage)[Symbol.for("mist-cli.flux")]?.get(id);
    if (!watch) return { records: [], dropped: 0, alive: false };
    watch.last = Date.now();
    const records = watch.buffer.splice(0);
    const dropped = watch.dropped;
    watch.dropped = 0;
    return { records, dropped, alive: true };
}

function stop(id: string): number {
    const watches = (globalThis as FluxPage)[Symbol.for("mist-cli.flux")];
    watches?.get(id)?.stop();
    return watches?.size ?? 0;
}

/** Undoes `start` in the page; safe to call again */
export const stopFlux = (send: Send, id: string) => pageCall(send, stop, [id]);

export interface WatchOptions {
    types: string[];
    /** Stop after this many actions; null keeps watching until `stopped` says so */
    count: number | null;
    limits: Limits;
    pollMs?: number;
    ttlMs?: number;
    /** Checked between polls; true ends the watch */
    stopped?: () => boolean;
}

/**
 * Watches dispatches until `count` actions arrived or `stopped()`, passing each batch to `onBatch`,
 * and removes the page's listener whatever ends it. If the CLI dies without that, the page removes
 * the listener itself `ttlMs` after the last drain.
 */
export async function watchFlux(send: Send, options: WatchOptions, onBatch: (batch: FluxBatch) => void): Promise<void> {
    const { types, count, limits, pollMs = 250, ttlMs = WATCH_TTL_MS, stopped = () => false } = options;
    const id = watchId();
    await pageCall(send, start, [id, { types, limit: count, ttlMs, limits } satisfies StartOptions], true);
    let printed = 0;
    try {
        while (!stopped() && (count === null || printed < count)) {
            await sleep(pollMs);
            const batch = await pageCall(send, take, [id]);
            if (count !== null) batch.records = batch.records.slice(0, count - printed);
            printed += batch.records.length;
            onBatch(batch);
            if (!batch.alive) break;
        }
    } finally {
        await stopFlux(send, id).catch(() => { });
    }
}
