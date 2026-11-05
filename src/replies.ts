/** The page side of native requests: `mist.requests.handle`, answering what nativeRequests asks. */
import type { PluginContext } from "@evi/api";

import { errorMessage, type EventsAnswer, HIDDEN, type ReplyOutcome, type RequestEvent } from "./protocol.ts";
import { subscribe } from "./subscribe.ts";
import { isRecord } from "./util.ts";

type RequestFn = (payload: any) => unknown;

/** The requests a native module makes, from its `__mist_requests` method's type */
export type RequestsOf<N> = N extends Record<typeof HIDDEN.requests, (...args: any[]) => Promise<{ readonly __requests?: infer R; }>>
    ? NonNullable<R> : {};

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
    protocol(context: PluginContext<any>): Promise<number>;
    poll(context: PluginContext<any>, boot: string | null, cursor: number): Promise<EventsAnswer<RequestEvent>>;
    report(line: string, err: unknown): void;
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

    async function listen(context: PluginContext<any>, handlers: Map<string, RequestFn>) {
        if (await source.protocol(context) < 1) {
            source.report("mist.requests: the native side doesn't make requests; it needs defineNative from @aurologic/mist-api 0.3 or later", new Error("no __mist_protocol"));
            return;
        }
        subscribe<RequestEvent>({
            onDispose: fn => context.onDispose(fn),
            poll: (boot, cursor) => source.poll(context, boot, cursor),
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
