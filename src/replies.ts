/** The page side of native requests: `mist.requests.handle`, answering what nativeRequests asks. */
import type { PluginContext } from "@evi/api";

import { errorMessage, onEnd } from "./internal.ts";
import { type EventsAnswer, HIDDEN, type ReplyOutcome, type RequestEvent } from "./protocol.ts";
import { subscribe } from "./subscribe.ts";
import { isRecord } from "./util.ts";
import { backoff } from "./util/backoff.ts";
import { sleep } from "./util/sleep.ts";

type RequestFn = (payload: any) => unknown;

/** The requests a native module makes, from its `__mist_requests` method's type */
export type RequestsOf<N> = N extends Record<typeof HIDDEN.requests, (...args: any[]) => Promise<infer A>>
    ? NonNullable<A> extends { readonly __requests?: infer R; } ? NonNullable<R> : {} : {};

export interface MistRequests<R> {
    /**
     * Answers the native side's requests named `name` while the plugin runs. What `handler` returns,
     * or awaits, goes back to the native side; a throw goes back as a failure. Replaces an earlier
     * handler for the name. Returns a function that removes it.
     */
    handle<K extends keyof R & string>(
        name: K,
        handler: R[K] extends RequestFn ? (payload: Parameters<R[K]>[0]) => Awaited<ReturnType<R[K]>> | Promise<Awaited<ReturnType<R[K]>>> : never,
    ): () => void;
}

export interface RepliesSource {
    context(): PluginContext<any>;
    /** The native side's call protocol: 0 when it has none, undefined when asking failed for now */
    protocol(context: PluginContext<any>): Promise<number | undefined>;
    /** Null when the native side was made without `requests` */
    poll(context: PluginContext<any>, boot: string | null, cursor: number): Promise<EventsAnswer<RequestEvent> | null>;
    report(line: string, err?: unknown): void;
    /** The first wait before asking for the protocol again after a failed ask. Default 1000 */
    retryMs?: number;
}

const isRequest = (value: unknown): value is RequestEvent =>
    isRecord(value) && typeof value.id === "string" && typeof value.name === "string";

export function createRequests<R>(source: RepliesSource): MistRequests<R> {
    const runs = new WeakMap<object, Map<string, RequestFn>>();

    async function answer(context: PluginContext<any>, handlers: Map<string, RequestFn>, request: RequestEvent) {
        const handler = handlers.get(request.name);
        let outcome: ReplyOutcome;
        if (!handler) outcome = { ok: false, message: `The page has no handler for ${request.name}`, unhandled: true };
        else {
            try {
                outcome = { ok: true, value: await handler(request.payload) };
            } catch (err) {
                outcome = { ok: false, message: errorMessage(err) };
            }
        }
        try {
            await context.native.call(HIDDEN.reply, request.id, outcome);
        } catch (err) {
            source.report(`Couldn't send the answer to ${request.name} to the native side`, err);
            // Most likely an answer IPC can't clone: the native side still learns it failed
            if (outcome.ok) await context.native.call(HIDDEN.reply, request.id, { ok: false, message: errorMessage(err) } satisfies ReplyOutcome).catch(() => { });
        }
    }

    /** Whether the native side speaks the call protocol, asking again with backoff until it says or the run ends */
    async function speaksProtocol(context: PluginContext<any>): Promise<boolean> {
        const ended = new AbortController();
        const forget = onEnd(context, () => ended.abort());
        const retry = backoff({ baseMs: source.retryMs ?? 1000 });
        try {
            for (; ;) {
                const version = await source.protocol(context);
                if (version !== undefined) {
                    if (version < 1) source.report("mist.requests: the native side has no __mist_protocol and can't make requests; it needs defineNative from @aurologic/mist-api 0.3 or later.");
                    return version >= 1;
                }
                await sleep(retry.next(), ended.signal);
            }
        } catch {
            return false;
        } finally {
            forget();
        }
    }

    async function listen(context: PluginContext<any>, handlers: Map<string, RequestFn>) {
        if (!await speaksProtocol(context)) return;
        const off = subscribe<RequestEvent>({
            onDispose: fn => onEnd(context, fn),
            async poll(boot, cursor) {
                const answer = await source.poll(context, boot, cursor);
                if (answer) return answer;
                source.report("mist.requests: the native side makes no requests; pass { requests } from nativeRequests to defineNative.");
                off();
                return { boot: "", cursor: 0, fresh: false, events: [] };
            },
            report: source.report,
        }, request => {
            if (isRequest(request)) void answer(context, handlers, request);
        });
    }

    return {
        handle(name, handler) {
            const context = source.context();
            let handlers = runs.get(context);
            if (!handlers) {
                runs.set(context, handlers = new Map());
                void listen(context, handlers);
            }
            const fn = handler as RequestFn;
            handlers.set(name, fn);
            return () => {
                if (handlers.get(name) === fn) handlers.delete(name);
            };
        },
    };
}
