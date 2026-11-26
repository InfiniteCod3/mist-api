/** `@aurologic/mist-api/native`: the main-process side of a plugin. Each native bundle carries a copy of this module. */
import type { NativeContext } from "@evi/api/native";

import { toWire } from "./errors.ts";
import { channelOf, type NativeEvents } from "./events.ts";
import { isThenable, type Method, stoppedError } from "./internal.ts";
import { hasOwner, type LogOwner, setOwner } from "./native-log.ts";
import { CALL_PROTOCOL, type CallAnswer, type CallMark, type EventsAnswer, HIDDEN, HIDDEN_PREFIX, isHidden, type NativeLogs, type RequestEvent } from "./protocol.ts";
import { createRecorder, type RecordingOptions } from "./recorder.ts";
import { type NativeRequests, type RequestMap, requestChannelOf } from "./requests.ts";
import { isRecord } from "./util.ts";

export { log } from "./native-log.ts";
export { nativeEvents, type NativeEvents, type NativeEventsOptions } from "./events.ts";
export { NativeError } from "./errors.ts";
export { nativeRequests, type NativeRequests, type NativeRequestsOptions, type RequestMap, type RequestOptions } from "./requests.ts";
export { lifetime, type Lifetime, type LifetimeOptions, run, type RunOptions, type RunResult, which } from "./lifetime.ts";
export { dataFolder, jsonFile, type JsonFile, type JsonFileOptions, writeAtomic, writeAtomicSync } from "./files.ts";
export { discordWindow } from "./window.ts";
export { secrets, type Secrets } from "./secrets.ts";
export { type GrantHandle, type PickOptions, pathGrants, type PathGrants } from "./grants.ts";
export { type BadArgument, check, type HttpsOptions, type IntOptions, type ListOptions, type TextOptions } from "./check.ts";
export { privateSession, type PrivateSession, type PrivateSessionOptions } from "./session.ts";
export { loginWindow, type LoginWindowOptions, openExternal, type OpenExternalOptions } from "./open.ts";
export type { EventsAnswer } from "./protocol.ts";

/** `this` inside a native method, start and stop: the module, plus what belongs to this one call */
export interface NativeCall {
    /**
     * Aborts when the page aborts the call (`mist.native.method.with({ signal })`) or the native side
     * stops. In start and stop it is the run's signal.
     */
    readonly signal: AbortSignal;
}

/** The methods as written; start and stop get Evi's lifecycle types: `start(ctx)` needs no annotation */
export type NativeMethods<M> = {
    [K in keyof M]: K extends "start" ? (ctx: NativeContext) => void : K extends "stop" ? () => void : M[K];
} & ThisType<M & NativeCall>;

/** Options for the native side's records of its calls and its log, and its event channel. Method names are the module's methods. */
export interface NativeOptions<M = Record<string, Method>, E = never, R extends RequestMap<R> = {}> extends RecordingOptions<Exclude<keyof M & string, "start" | "stop">> {
    /** The channel from nativeEvents that the page reads with `mist.events.subscribe` */
    events?: NativeEvents<E>;
    /** The requests from nativeRequests that the page answers with `mist.requests.handle` */
    requests?: NativeRequests<R>;
}

/** The module defineNative returns. The page infers its method and event types from it (createMist's second type parameter). */
export type MistNative<M, E = never, R extends RequestMap<R> = {}> = M & {
    start(ctx: NativeContext): void;
    stop(): void;
    [HIDDEN.debugAllowed](): boolean;
    [HIDDEN.logs](n?: unknown, full?: unknown): NativeLogs;
    [HIDDEN.events](boot?: unknown, cursor?: unknown): Promise<EventsAnswer<E>>;
    [HIDDEN.protocol](): number;
    [HIDDEN.abort](id?: unknown): boolean;
    /** Typed with R so the page can infer what `mist.requests.handle` takes */
    [HIDDEN.requests](boot?: unknown, cursor?: unknown): Promise<(EventsAnswer<RequestEvent> & { readonly __requests?: R; }) | null>;
    [HIDDEN.reply](id?: unknown, outcome?: unknown): boolean;
};

/**
 * Whether Discord's main process was started with a debugging port or pipe. Anyone who can use one
 * already controls the app: values and calls are opened to them. The page can't change main's argv.
 */
export function debugAllowed(argv: readonly string[] = process.argv) {
    return argv.some(arg => /^--remote-debugging-(?:port|pipe)(?:=|$)/.test(arg));
}

/** How long, and how many, ids of aborts that came before their call are remembered */
const EARLY_ABORT_MS = 30_000;
const EARLY_ABORT_MAX = 256;

const isCallMark = (value: unknown): value is CallMark =>
    isRecord(value) && value.__mist_call === 1 && (value.id === null || typeof value.id === "string");

/**
 * Wraps a native module: each method's calls are recorded, and the hidden methods the page side
 * uses are added. `this` inside a method is the module with that call's `signal`.
 * Runs once per native bundle: `log` records into the ring it makes.
 */
export function defineNative<M extends Record<string, Method>, E = never, R extends RequestMap<R> = {}>(
    methods: NativeMethods<M>,
    options: NativeOptions<NoInfer<M>, E, R> = {},
): MistNative<M, E, R> {
    for (const name of Object.keys(methods)) {
        if (isHidden(name)) throw new Error(`defineNative: method names starting with ${HIDDEN_PREFIX} are reserved, got ${name}`);
    }
    if (hasOwner()) throw new Error("defineNative: already ran in this native bundle. Make one native module per plugin.");
    const { events, requests, ...recording } = options;
    const channel = events && channelOf(events);
    if (events && !channel) throw new Error("defineNative: events must come from nativeEvents");
    const asks = requests && requestChannelOf(requests);
    if (requests && !asks) throw new Error("defineNative: requests must come from nativeRequests");

    // The page's long polls would push every other call out of the ring: they're only counted
    const recorder = createRecorder({ ...recording, quiet: [...recording.quiet ?? [], HIDDEN.events, HIDDEN.requests], keepValues: debugAllowed() });
    const self: LogOwner = { recorder, prefix: "[mist]" };
    setOwner(self);
    /** The plugin id from the last start, which names the plugin in the stop's abort reason */
    let pluginId = "mist";

    /** Aborts every call of the current run on stop */
    let run = new AbortController();
    /** Calls the page can abort, by the id in their CallMark */
    const abortable = new Map<string, AbortController>();
    /** Ids the page aborted before their call arrived, with when each is forgotten. Insertion order is expiry order. */
    const abortedEarly = new Map<string, number>();
    const rememberAbort = (id: string) => {
        const now = Date.now();
        for (const [old, until] of abortedEarly) {
            if (until > now && abortedEarly.size < EARLY_ABORT_MAX) break;
            abortedEarly.delete(old);
        }
        abortedEarly.set(id, now + EARLY_ABORT_MS);
    };
    const takeEarlyAbort = (id: string) => {
        const until = abortedEarly.get(id);
        abortedEarly.delete(id);
        return until !== undefined && until > Date.now();
    };
    const pageAbort = () => new DOMException("The page aborted the call", "AbortError");
    /** The `this` of each call in flight: a method calling another through `this` passes its signal on */
    const callThis = new WeakSet<object>();

    const lifecycle = methods as { start?: (ctx: NativeContext) => void; stop?: () => void; };
    const module: Record<string, unknown> = {};
    // A proxy, not Object.create(module): a method that keeps state on `this` must still write to the module
    const withSignal = (signal: AbortSignal): object => new Proxy(module, { get: (target, key) => key === "signal" ? signal : Reflect.get(target, key) });

    function invoke(name: string, fn: Method, outer: unknown, args: unknown[]) {
        const mark = isCallMark(args.at(-1)) ? args.pop() as CallMark : undefined;
        const inherited = typeof outer === "object" && outer !== null && callThis.has(outer);
        let signal = inherited ? (outer as NativeCall).signal : run.signal;
        let forget = () => { };
        const id = mark?.id;
        if (id && !abortable.has(id)) {
            const controller = new AbortController();
            const runSignal = run.signal;
            // Not AbortSignal.any: Node 22 keeps each one it makes listening on the run's signal until the run aborts
            const onStop = () => controller.abort(runSignal.reason);
            runSignal.addEventListener("abort", onStop, { once: true });
            abortable.set(id, controller);
            if (takeEarlyAbort(id)) controller.abort(pageAbort());
            else if (runSignal.aborted) controller.abort(runSignal.reason);
            signal = controller.signal;
            forget = () => {
                runSignal.removeEventListener("abort", onStop);
                abortable.delete(id);
            };
        }
        const receiver: object = inherited ? outer : withSignal(signal);
        callThis.add(receiver);

        if (!mark) {
            try {
                const result = recorder.track(name, args, () => fn.apply(receiver, args));
                if (isThenable(result)) result.then(forget, forget);
                else forget();
                return result;
            } catch (err) {
                forget();
                throw err;
            }
        }
        // A page that sent a mark gets every outcome as a CallAnswer, which Electron passes untouched
        return (async (): Promise<CallAnswer> => {
            try {
                return { __mist_answer: 1, ok: true, value: await recorder.track(name, args, () => fn.apply(receiver, args)) };
            } catch (err) {
                return { __mist_answer: 1, ok: false, error: toWire(err) };
            } finally {
                forget();
            }
        })();
    }

    for (const [name, fn] of Object.entries(methods)) {
        if (typeof fn !== "function" || name === "start" || name === "stop") continue;
        module[name] = function (this: unknown, ...args: unknown[]) {
            return invoke(name, fn as Method, this, args);
        };
    }
    module.start = function (ctx: NativeContext) {
        pluginId = ctx.pluginId;
        self.prefix = `[${pluginId}]`;
        if (run.signal.aborted) run = new AbortController();
        channel?.start();
        asks?.start();
        return lifecycle.start?.call(withSignal(run.signal), ctx);
    };
    module.stop = function () {
        try {
            return lifecycle.stop?.call(withSignal(run.signal));
        } finally {
            run.abort(stoppedError(pluginId));
            abortable.clear();
            abortedEarly.clear();
            channel?.stop();
            asks?.stop();
        }
    };
    module[HIDDEN.events] = (boot?: unknown, cursor?: unknown) => recorder.track(HIDDEN.events, [boot, cursor], () =>
        channel ? channel.poll(boot, cursor) : Promise.reject(new Error("defineNative: this module has no event channel. Pass { events } to defineNative.")));
    module[HIDDEN.requests] = (boot?: unknown, cursor?: unknown) => recorder.track(HIDDEN.requests, [boot, cursor], () =>
        asks ? asks.poll(boot, cursor) : Promise.resolve(null));
    module[HIDDEN.reply] = (id?: unknown, outcome?: unknown) => asks?.reply(id, outcome) ?? false;
    module[HIDDEN.abort] = (id?: unknown) => {
        if (typeof id !== "string") return false;
        const controller = abortable.get(id);
        // The call may still be on its way: it starts aborted if it comes soon
        if (!controller) {
            rememberAbort(id);
            return false;
        }
        controller.abort(pageAbort());
        return true;
    };
    module[HIDDEN.protocol] = () => CALL_PROTOCOL;
    module[HIDDEN.debugAllowed] = () => debugAllowed();
    module[HIDDEN.logs] = (n?: unknown, full?: unknown): NativeLogs => {
        const count = typeof n === "number" ? n : undefined;
        return full === true && recorder.keepsValues
            ? { full: true, calls: recorder.calls(count, true), logs: recorder.logs(count, true), quiet: recorder.quiet() }
            : { full: false, calls: recorder.calls(count, false), logs: recorder.logs(count, false), quiet: recorder.quiet() };
    };
    return module as MistNative<M, E, R>;
}
