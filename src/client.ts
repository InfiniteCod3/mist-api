/**
 * The page's native calls: `mist.native`. A native side that speaks CALL_PROTOCOL gets a CallMark on
 * each call and answers with a CallAnswer, so errors keep their type and calls can be aborted.
 * Anything else (a plain module, an older mist) gets the call as Evi passes it.
 */
import type { PluginContext } from "@evi/api";

import { fromWire, isCallAnswer } from "./errors.ts";
import { type CallMark, HIDDEN, type HiddenMethod, type WireError } from "./protocol.ts";

type Method = (...args: any[]) => unknown;

export interface CallOptions {
    /**
     * Aborting rejects the call with the signal's reason at once. A native side made with mist 0.3's
     * defineNative also sees it: the method's `this.signal` aborts.
     */
    signal?: AbortSignal;
}

/** A native method as the page calls it, with `with` for per-call options */
export type NativeFunction<F> = F & { with(options: CallOptions): F; };

/**
 * The page's view of a native module: every method but start, stop and mist's hidden ones, each
 * returning a promise of what it returns (Electron's IPC structured-clones it on the way). A method
 * that returns a promise already keeps its own type, so a generic one keeps its type parameters,
 * which inferring its arguments and result would erase.
 */
export type NativeClient<N> = {
    [K in keyof N as K extends "start" | "stop" | HiddenMethod ? never : N[K] extends Method ? K : never]: NativeFunction<
        N[K] extends (...args: any[]) => Promise<unknown> ? N[K]
        : N[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never>;
};

export interface ClientSource {
    context(): PluginContext<any>;
    /** Records the call around `run` */
    track(method: string, args: unknown[], run: () => Promise<unknown>): Promise<unknown>;
}

function unwrap(answer: unknown) {
    if (!isCallAnswer(answer)) return answer;
    if (answer.ok) return answer.value;
    const error = answer.error as Partial<WireError> | undefined;
    throw fromWire({ name: String(error?.name ?? "Error"), message: String(error?.message ?? "The native method failed"), code: error?.code, data: error?.data, status: error?.status });
}

/** Rejects with the signal's reason as soon as it aborts, and leaves `pending` to settle unobserved */
function abortable<T>(pending: Promise<T>, signal: AbortSignal, onAbort: () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const aborted = () => {
            onAbort();
            reject(signal.reason);
        };
        signal.addEventListener("abort", aborted, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    });
}

export function createNativeClient(source: ClientSource) {
    const protocols = new WeakMap<object, Promise<number>>();

    /** The native side's CALL_PROTOCOL, or 0 without one; asked once per run */
    function protocol(context: PluginContext<any>): Promise<number> {
        let known = protocols.get(context);
        if (!known) {
            let asked: Promise<unknown>;
            try {
                asked = context.native.call(HIDDEN.protocol);
            } catch {
                // Evi throws right away for a plugin without a native module; the call itself throws the same
                asked = Promise.resolve(0);
            }
            known = asked.then(answer => typeof answer === "number" ? answer : 0, () => 0);
            protocols.set(context, known);
        }
        return known;
    }

    async function send(method: string, args: unknown[], signal: AbortSignal | undefined): Promise<unknown> {
        const context = source.context();
        signal?.throwIfAborted();
        const version = method.startsWith("__mist_") ? 0 : await protocol(context);
        signal?.throwIfAborted();
        if (version < 1) {
            const pending = context.native.call(method, ...args);
            return signal ? abortable(pending, signal, () => { }) : pending;
        }
        const id = signal ? crypto.randomUUID() : null;
        const mark: CallMark = { __mist_call: 1, id };
        const pending = context.native.call(method, ...args, mark).then(unwrap);
        if (!signal) return pending;
        return abortable(pending, signal, () => void context.native.call(HIDDEN.abort, id).catch(() => { }));
    }

    const call = (method: string, args: unknown[], options: CallOptions = {}) =>
        source.track(method, args, () => send(method, args, options.signal));

    const native = new Proxy({}, {
        // `then` stays undefined so the client isn't mistaken for a promise
        get(_, method) {
            if (typeof method !== "string" || method === "then") return undefined;
            const fn = (...args: unknown[]) => call(method, args);
            fn.with = (options: CallOptions) => (...args: unknown[]) => call(method, args, options);
            return fn;
        },
    });

    return { native, call, protocol };
}
