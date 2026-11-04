/** `@aurologic/mist-api/native`: the main-process side of a plugin. Each native bundle carries its own copy of this module. */
import type { NativeContext } from "@evi/api/native";

import { channelOf, type NativeEvents } from "./events.ts";
import { type EventsAnswer, HIDDEN, type LogLevel, type NativeLogs } from "./protocol.ts";
import { createRecorder, type Recorder, type RecordingOptions } from "./recorder.ts";

export { nativeEvents, type NativeEvents, type NativeEventsOptions } from "./events.ts";
export type { EventsAnswer } from "./protocol.ts";

/** Anything a native module exports besides start and stop is callable from the page */
type Method = (...args: any[]) => unknown;

/** The methods as written; start and stop get Evi's lifecycle types, so `start(ctx)` needs no annotation */
export type NativeMethods<M> = {
    [K in keyof M]: K extends "start" ? (ctx: NativeContext) => void : K extends "stop" ? () => void : M[K];
};

/** Options for the native side's records of its calls and its log, and its event channel. Method names are the module's own. */
export interface NativeOptions<M = Record<string, Method>, E = never> extends RecordingOptions<Exclude<keyof M & string, "start" | "stop">> {
    /** The channel from nativeEvents that the page reads with `mist.events.subscribe` */
    events?: NativeEvents<E>;
}

/** The module defineNative returns. The page infers its method and event types from it (createMist's second type parameter). */
export type MistNative<M, E = never> = M & {
    start(ctx: NativeContext): void;
    stop(): void;
    [HIDDEN.debugAllowed](): boolean;
    [HIDDEN.logs](n?: unknown, full?: unknown): NativeLogs;
    [HIDDEN.events](boot?: unknown, cursor?: unknown): Promise<EventsAnswer<E>>;
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

/**
 * Wraps a native module: each method's calls are recorded, and the hidden methods the page side
 * uses for debugging are added. `this` inside a method is the returned module, as Evi calls it.
 * Runs once per native bundle, since `log` records into the ring it makes.
 */
export function defineNative<M extends Record<string, Method>, E = never>(methods: NativeMethods<M>, options: NativeOptions<NoInfer<M>, E> = {}): MistNative<M, E> {
    for (const name of Object.keys(methods)) {
        if (name.startsWith("__mist_")) throw new Error(`Native method names starting with __mist_ are reserved: ${name}`);
    }
    if (owner) throw new Error("defineNative already ran in this native bundle: make one native module per plugin");
    const { events, ...recording } = options;
    const channel = events && channelOf(events);
    if (events && !channel) throw new Error("defineNative's events must come from nativeEvents");

    // The page's long poll would push every other call out of the ring, so it's only counted
    const recorder = createRecorder({ ...recording, quiet: [...recording.quiet ?? [], HIDDEN.events], keepValues: debugAllowed() });
    for (const line of early.splice(0)) recorder.log(line.level, line.args, line.at);
    const self = owner = { recorder, prefix: "[mist]" };

    const lifecycle = methods as { start?: (ctx: NativeContext) => void; stop?: () => void; };
    const module: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(methods)) {
        if (typeof fn !== "function" || name === "start" || name === "stop") continue;
        module[name] = function (this: unknown, ...args: unknown[]) {
            return recorder.track(name, args, () => (fn as Method).apply(this, args));
        };
    }
    module.start = function (this: unknown, ctx: NativeContext) {
        self.prefix = `[${ctx.pluginId}]`;
        channel?.start();
        return lifecycle.start?.call(this, ctx);
    };
    module.stop = function (this: unknown) {
        try {
            return lifecycle.stop?.call(this);
        } finally {
            channel?.stop();
        }
    };
    module[HIDDEN.events] = (boot?: unknown, cursor?: unknown) => recorder.track(HIDDEN.events, [boot, cursor], () =>
        channel ? channel.poll(boot, cursor) : Promise.reject(new Error("This native module has no event channel: pass { events } to defineNative")));
    module[HIDDEN.debugAllowed] = () => debugAllowed();
    module[HIDDEN.logs] = (n?: unknown, full?: unknown): NativeLogs => {
        const count = typeof n === "number" ? n : undefined;
        return full === true && recorder.keepsValues
            ? { full: true, calls: recorder.calls(count, true), logs: recorder.logs(count, true), quiet: recorder.quiet() }
            : { full: false, calls: recorder.calls(count, false), logs: recorder.logs(count, false), quiet: recorder.quiet() };
    };
    return module as MistNative<M, E>;
}
