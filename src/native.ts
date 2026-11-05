/** `@aurologic/mist-api/native`: the main-process side of a plugin. Each native bundle carries its own copy of this module. */
import type { NativeContext } from "@evi/api/native";

import { toWire } from "./errors.ts";
import { channelOf, type NativeEvents } from "./events.ts";
import { CALL_PROTOCOL, type CallAnswer, type CallMark, type EventsAnswer, HIDDEN, type LogLevel, type NativeLogs, type RequestEvent } from "./protocol.ts";
import { createRecorder, type Recorder, type RecordingOptions } from "./recorder.ts";
import { type NativeRequests, type RequestMap, requestChannelOf } from "./requests.ts";
import { isRecord } from "./util.ts";

export { nativeEvents, type NativeEvents, type NativeEventsOptions } from "./events.ts";
export { NativeError } from "./errors.ts";
export { nativeRequests, type NativeRequests, type NativeRequestsOptions, type RequestMap, type RequestOptions } from "./requests.ts";
export { lifetime, type Lifetime, type LifetimeOptions, run, type RunOptions, type RunResult, which } from "./lifetime.ts";
export { dataFolder, jsonFile, type JsonFile, type JsonFileOptions } from "./files.ts";
export { discordWindow } from "./window.ts";
export { secrets, type Secrets } from "./secrets.ts";
export { type GrantHandle, type PickOptions, pathGrants, type PathGrants } from "./grants.ts";
export type { EventsAnswer } from "./protocol.ts";

/** Anything a native module exports besides start and stop is callable from the page */
type Method = (...args: any[]) => unknown;

/** `this` inside a native method: the module, plus what belongs to this one call */
export interface NativeCall {
    /**
     * Aborts when the page aborts this call (`mist.native.method.with({ signal })`) or the native side
     * stops. A call made without a signal, or from a page without mist 0.3, only aborts on stop.
     */
    readonly signal: AbortSignal;
}

/** The methods as written; start and stop get Evi's lifecycle types, so `start(ctx)` needs no annotation */
export type NativeMethods<M> = {
    [K in keyof M]: K extends "start" ? (ctx: NativeContext) => void : K extends "stop" ? () => void : M[K];
} & ThisType<M & NativeCall>;

/** Options for the native side's records of its calls and its log, and its event channel. Method names are the module's own. */
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
 * already controls the app, so values and calls are opened to them. The page can't change main's argv.
 */
export function debugAllowed(argv: readonly string[] = process.argv) {
    return argv.some(arg => /^--remote-debugging-(?:port|pipe)(?:=|$)/.test(arg));
}

interface EarlyLine { at: number; level: LogLevel; args: unknown[]; }

let owner: { recorder: Recorder; prefix: string; } | undefined;
/** Lines logged before defineNative, recorded with its options once it runs. Bounded like the default ring. */
const early: EarlyLine[] = [];
const EARLY_MAX = 200;

function write(level: LogLevel, args: unknown[]) {
    if (owner) owner.recorder.log(level, args);
    else if (early.push({ at: Date.now(), level, args }) > EARLY_MAX) early.shift();
    console[level](owner?.prefix ?? "[mist]", ...args);
}

/** Logging for native code: kept for `mist native-logs` and printed to main's stdout */
export const log = {
    log: (...args: unknown[]) => write("log", args),
    debug: (...args: unknown[]) => write("debug", args),
    info: (...args: unknown[]) => write("info", args),
    warn: (...args: unknown[]) => write("warn", args),
    error: (...args: unknown[]) => write("error", args),
};

const isCallMark = (value: unknown): value is CallMark =>
    isRecord(value) && value.__mist_call === 1 && (value.id === null || typeof value.id === "string");

/**
 * Wraps a native module: each method's calls are recorded, and the hidden methods the page side
 * uses are added. `this` inside a method is the module with the call's own `signal`.
 * Runs once per native bundle, since `log` records into the ring it makes.
 */
export function defineNative<M extends Record<string, Method>, E = never, R extends RequestMap<R> = {}>(
    methods: NativeMethods<M>,
    options: NativeOptions<NoInfer<M>, E, R> = {},
): MistNative<M, E, R> {
    for (const name of Object.keys(methods)) {
        if (name.startsWith("__mist_")) throw new Error(`Native method names starting with __mist_ are reserved: ${name}`);
    }
    if (owner) throw new Error("defineNative already ran in this native bundle: make one native module per plugin");
    const { events, requests, ...recording } = options;
    const channel = events && channelOf(events);
    if (events && !channel) throw new Error("defineNative's events must come from nativeEvents");
    const asks = requests && requestChannelOf(requests);
    if (requests && !asks) throw new Error("defineNative's requests must come from nativeRequests");

    // The page's long polls would push every other call out of the ring, so they're only counted
    const recorder = createRecorder({ ...recording, quiet: [...recording.quiet ?? [], HIDDEN.events, HIDDEN.requests], keepValues: debugAllowed() });
    for (const line of early.splice(0)) recorder.log(line.level, line.args, line.at);
    const self = owner = { recorder, prefix: "[mist]" };

    /** Aborts every call of the current run on stop */
    let run = new AbortController();
    /** Calls the page can abort, by the id in their CallMark */
    const abortable = new Map<string, AbortController>();
    /** The `this` of each call in flight, so a method calling another through `this` passes its signal on */
    const callThis = new WeakSet<object>();

    const lifecycle = methods as { start?: (ctx: NativeContext) => void; stop?: () => void; };
    const module: Record<string, unknown> = {};

    function invoke(name: string, fn: Method, outer: unknown, args: unknown[]) {
        const mark = isCallMark(args.at(-1)) ? args.pop() as CallMark : undefined;
        const inherited = typeof outer === "object" && outer !== null && callThis.has(outer);
        let signal = inherited ? (outer as NativeCall).signal : run.signal;
        let controller: AbortController | undefined;
        if (mark?.id && !abortable.has(mark.id)) {
            controller = new AbortController();
            abortable.set(mark.id, controller);
            signal = AbortSignal.any([run.signal, controller.signal]);
        }
        // A proxy, not Object.create(module): a method that keeps state on `this` must still write to the module
        const receiver: object = inherited ? outer : new Proxy(module, { get: (target, key) => key === "signal" ? signal : Reflect.get(target, key) });
        callThis.add(receiver);
        const forget = () => { if (controller) abortable.delete(mark!.id!); };

        if (!mark) {
            try {
                const result = recorder.track(name, args, () => fn.apply(receiver, args));
                if (result instanceof Promise) result.then(forget, forget);
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
    module.start = function (this: unknown, ctx: NativeContext) {
        self.prefix = `[${ctx.pluginId}]`;
        if (run.signal.aborted) run = new AbortController();
        channel?.start();
        asks?.start();
        return lifecycle.start?.call(this, ctx);
    };
    module.stop = function (this: unknown) {
        try {
            return lifecycle.stop?.call(this);
        } finally {
            run.abort(new DOMException(`${self.prefix.slice(1, -1)}'s native side stopped`, "AbortError"));
            abortable.clear();
            channel?.stop();
            asks?.stop();
        }
    };
    module[HIDDEN.events] = (boot?: unknown, cursor?: unknown) => recorder.track(HIDDEN.events, [boot, cursor], () =>
        channel ? channel.poll(boot, cursor) : Promise.reject(new Error("This native module has no event channel: pass { events } to defineNative")));
    module[HIDDEN.requests] = (boot?: unknown, cursor?: unknown) => recorder.track(HIDDEN.requests, [boot, cursor], () =>
        asks ? asks.poll(boot, cursor) : Promise.resolve(null));
    module[HIDDEN.reply] = (id?: unknown, outcome?: unknown) => asks?.reply(id, outcome) ?? false;
    module[HIDDEN.abort] = (id?: unknown) => {
        const controller = typeof id === "string" ? abortable.get(id) : undefined;
        controller?.abort(new DOMException("The page aborted the call", "AbortError"));
        return !!controller;
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
