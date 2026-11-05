/** mist flux: a watch on Discord's Flux dispatcher, kept in the page and drained by the CLI */
import { CdpError, evaluate, type Send } from "./cdp.ts";
import { type Limits, pageExpression } from "./page.ts";

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

/**
 * Page side. Named types go through Dispatcher.subscribe; every action needs an interceptor, which
 * Discord's dispatcher calls before any handler and skips the action when it returns true. The
 * watch lives under a Symbol.for key so the CLI's next evaluate finds it.
 */
function start(snapshot: (value: unknown, limits: Limits) => unknown, id: string, options: StartOptions) {
    const KEEP = 1000;
    const D = (globalThis as any).Evi.api.Dispatcher;
    const watches: Map<string, any> = (globalThis as any)[Symbol.for("mist-cli.flux")] ??= new Map();
    const watch = { buffer: [] as FluxRecord[], dropped: 0, kept: 0, last: Date.now(), stop: () => { } };
    let remove: () => void;
    const record = (action: { type: string; }) => {
        if (options.limit !== null && watch.kept >= options.limit) return;
        try {
            const { type, ...payload } = action;
            watch.buffer.push({ type, at: Date.now(), payload: snapshot(payload, options.limits) });
        } catch { }
        watch.kept++;
        if (watch.buffer.length > KEEP) watch.dropped += watch.buffer.splice(0, watch.buffer.length - KEEP).length;
    };
    if (options.types.length) {
        for (const type of options.types) D.subscribe(type, record);
        remove = () => { for (const type of options.types) D.unsubscribe(type, record); };
    } else {
        if (!Array.isArray(D._interceptors)) return "This Discord's dispatcher keeps no interceptor list, so mist can't watch every action. Name the action types.";
        const intercept = (action: { type: string; }) => {
            record(action);
            return false;
        };
        D.addInterceptor(intercept);
        remove = () => {
            const at = D._interceptors.indexOf(intercept);
            if (at >= 0) D._interceptors.splice(at, 1);
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
    const watch = (globalThis as any)[Symbol.for("mist-cli.flux")]?.get(id);
    if (!watch) return { records: [], dropped: 0, alive: false };
    watch.last = Date.now();
    const records = watch.buffer.splice(0);
    const dropped = watch.dropped;
    watch.dropped = 0;
    return { records, dropped, alive: true };
}

function stop(id: string) {
    const watches = (globalThis as any)[Symbol.for("mist-cli.flux")];
    watches?.get(id)?.stop();
    return watches?.size ?? 0;
}

/** Undoes `start` in the page; safe to call again */
export const stopFlux = (send: Send, id: string) => evaluate<number>(send, pageExpression(stop, [id]));

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
    const { types, count, limits, pollMs = 250, ttlMs = 15_000, stopped = () => false } = options;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const refused = await evaluate<string | null>(send, pageExpression(start, [id, { types, limit: count, ttlMs, limits } satisfies StartOptions], true));
    if (refused) throw new CdpError(refused);
    let printed = 0;
    try {
        while (!stopped() && (count === null || printed < count)) {
            await new Promise(resolve => setTimeout(resolve, pollMs));
            const batch = await evaluate<FluxBatch>(send, pageExpression(take, [id]));
            if (count !== null) batch.records = batch.records.slice(0, count - printed);
            printed += batch.records.length;
            onBatch(batch);
            if (!batch.alive) break;
        }
    } finally {
        await stopFlux(send, id).catch(() => { });
    }
}
