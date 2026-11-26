/** Flux actions on the page: `mist.flux`, through the running context. */
import type { FluxAction, PluginContext } from "@evi/api";

import { withTimeout } from "./util/timeout.ts";

export interface NextOptions<A extends FluxAction> {
    /** Waits for an action this returns true for */
    where?: (action: A) => boolean;
    /** Rejects with a TimeoutError DOMException after this many ms */
    timeout?: number;
    /** Rejects with its reason when it aborts */
    signal?: AbortSignal;
}

/** Flux actions through the running context: Evi guards, times and removes each handler */
export interface MistFlux {
    /** Calls `handler` with each action of the given types until the run stops or the returned function is called. Does nothing between runs. */
    on<A extends FluxAction = FluxAction>(types: string | readonly string[], handler: (action: A) => void): () => void;
    /** The next action of the given types. Rejects when the run stops, `signal` aborts or `timeout` passes. */
    next<A extends FluxAction = FluxAction>(types: string | readonly string[], options?: NextOptions<A>): Promise<A>;
}

export interface FluxSource {
    context(): PluginContext<any> | undefined;
    /** Aborts when the run stops; already aborted between runs */
    signal(): AbortSignal;
    /** Something subscribed between runs, which does nothing */
    idle(what: string): void;
}

export function createFlux(source: FluxSource): MistFlux {
    const flux: MistFlux = {
        on<A extends FluxAction = FluxAction>(types: string | readonly string[], handler: (action: A) => void) {
            const context = source.context();
            if (!context) {
                source.idle("mist.flux.on");
                return () => { };
            }
            const offs: (() => void)[] = [];
            const off = () => { for (const unsubscribe of offs.splice(0)) unsubscribe(); };
            try {
                for (const type of [types].flat()) offs.push(context.flux.subscribe(type, handler as (action: FluxAction) => void));
            } catch (err) {
                off();
                throw err;
            }
            return off;
        },

        next<A extends FluxAction = FluxAction>(types: string | readonly string[], { where, timeout, signal }: NextOptions<A> = {}) {
            const wait = (abort: AbortSignal) => new Promise<A>((resolve, reject) => {
                abort.throwIfAborted();
                let off = () => { };
                const settle = (fn: () => void) => {
                    off();
                    abort.removeEventListener("abort", onAbort);
                    fn();
                };
                const onAbort = () => settle(() => reject(abort.reason));
                // Subscribed before the abort listener goes on: when `on` throws, nothing is left on the signal
                off = flux.on<A>(types, action => {
                    try {
                        if (where && !where(action)) return;
                    } catch (err) {
                        return settle(() => reject(err));
                    }
                    settle(() => resolve(action));
                });
                abort.addEventListener("abort", onAbort, { once: true });
            });
            const run = source.signal();
            const linked = signal ? AbortSignal.any([run, signal]) : run;
            return timeout === undefined ? wait(linked) : withTimeout(wait, timeout, linked);
        },
    };
    return flux;
}
