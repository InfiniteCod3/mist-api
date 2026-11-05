/**
 * Requests from the native side that the page answers: a second event channel the page long-polls
 * (`__mist_requests`), and a hidden method it replies through (`__mist_reply`).
 */
import { NativeError } from "./errors.ts";
import { channelOf, type EventChannel, nativeEvents } from "./events.ts";
import type { EventsAnswer, ReplyOutcome, RequestEvent } from "./protocol.ts";
import { isRecord } from "./util.ts";

/** Request names to what the page is given and what it answers, as in `{ confirm(text: string): boolean }` */
export type RequestMap<R> = { [K in keyof R]: (payload: any) => unknown; };

export interface NativeRequestsOptions {
    /** How long a request waits for the page's answer. Default 30000 */
    timeoutMs?: number;
}

export interface RequestOptions {
    /** Overrides the channel's timeoutMs for this request */
    timeoutMs?: number;
    signal?: AbortSignal;
}

/** Pass to defineNative as `requests`; the page answers with `mist.requests.handle` */
export interface NativeRequests<R extends RequestMap<R>> {
    /**
     * Asks the page and waits for its answer. The answer comes from the page, so it is untrusted
     * input whatever R says: validate it. Rejects with a NativeError whose code is
     * "request-timeout", "request-stopped", "request-unhandled" or "request-failed", or with the
     * signal's reason.
     */
    request<K extends keyof R & string>(name: K, payload: Parameters<R[K]>[0], options?: RequestOptions): Promise<Awaited<ReturnType<R[K]>>>;
}

/** What defineNative drives */
export interface RequestChannel {
    poll(boot: unknown, cursor: unknown): Promise<EventsAnswer<RequestEvent>>;
    reply(id: unknown, outcome: unknown): boolean;
    start(): void;
    stop(): void;
}

const channels = new WeakMap<object, RequestChannel>();

export const requestChannelOf = (requests: object) => channels.get(requests);

interface Pending { resolve(value: unknown): void; reject(err: unknown): void; }

function parseOutcome(outcome: unknown): ReplyOutcome | null {
    if (!isRecord(outcome)) return null;
    if (outcome.ok === true) return { ok: true, value: outcome.value };
    if (outcome.ok === false) return { ok: false, message: typeof outcome.message === "string" ? outcome.message.slice(0, 1000) : "The page's handler failed", unhandled: outcome.unhandled === true };
    return null;
}

export function nativeRequests<R extends RequestMap<R>>({ timeoutMs = 30_000 }: NativeRequestsOptions = {}): NativeRequests<R> {
    if (!(timeoutMs > 0)) throw new RangeError(`timeoutMs must be more than 0, got ${timeoutMs}`);
    const pending = new Map<string, Pending>();
    const queue = nativeEvents<RequestEvent>({ replay: e => pending.has(e.id), live: e => pending.has(e.id) });
    const channel = channelOf(queue) as EventChannel<RequestEvent>;
    let stopped = false;

    const requests: NativeRequests<R> = {
        request(name, payload, { timeoutMs: wait = timeoutMs, signal } = {}) {
            if (stopped) return Promise.reject(new NativeError("request-stopped", undefined, "The native side is stopped"));
            if (signal?.aborted) return Promise.reject(signal.reason);
            const id = crypto.randomUUID();
            return new Promise((resolve, reject) => {
                const settle = () => {
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", onAbort);
                    pending.delete(id);
                };
                const onAbort = () => {
                    settle();
                    reject(signal!.reason);
                };
                const timer = setTimeout(() => {
                    settle();
                    reject(new NativeError("request-timeout", { name }, `The page didn't answer ${name} within ${wait} ms`));
                }, wait);
                signal?.addEventListener("abort", onAbort, { once: true });
                pending.set(id, {
                    resolve: value => { settle(); resolve(value as Awaited<ReturnType<R[typeof name]>>); },
                    reject: err => { settle(); reject(err); },
                });
                queue.push({ id, name, payload });
            });
        },
    };

    channels.set(requests, {
        poll: (boot, cursor) => channel.poll(boot, cursor),
        reply(id, outcome) {
            const waiting = typeof id === "string" ? pending.get(id) : undefined;
            const parsed = parseOutcome(outcome);
            if (!waiting || !parsed) return false;
            if (parsed.ok) waiting.resolve(parsed.value);
            else if (parsed.unhandled) waiting.reject(new NativeError("request-unhandled", undefined, parsed.message));
            else waiting.reject(new NativeError("request-failed", undefined, parsed.message));
            return true;
        },
        start() {
            stopped = false;
            channel.start();
        },
        stop() {
            stopped = true;
            for (const waiting of [...pending.values()]) waiting.reject(new NativeError("request-stopped", undefined, "The native side stopped before the page answered"));
            channel.stop();
        },
    });

    return requests;
}
