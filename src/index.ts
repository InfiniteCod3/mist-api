/** `@aurologic/mist-api`: the page side of a plugin. */
import type { CommandDefinition, PluginContext, PluginDefinition, SettingsSchema, SettingsValues } from "@evi/api";

import { createDebug } from "./debug.ts";
import { checkProvides, describeMismatch, mismatches, type Need, type Provides, toastFor } from "./needs.ts";
import { errorMessage, type EventsAnswer, HIDDEN, type HiddenMethod, type LogLevel } from "./protocol.ts";
import { createRecorder, type RecordingOptions } from "./recorder.ts";
import { eviOf, registry } from "./registry.ts";
import { buildReport, copyText } from "./report.ts";
import { whileStarting } from "./start.ts";
import { type MistEvents, subscribe } from "./subscribe.ts";

export { onDemand } from "./patches.ts";
export { MIST_VERSION } from "./protocol.ts";
export type { CallOutcome, CallRecord, EventsAnswer, LogLevel, LogRecord, NativeLogs, ReducedNativeLogs, Shown } from "./protocol.ts";
export type { MistEvents, SubscribeOptions } from "./subscribe.ts";
export type { MistCapability } from "./debug.ts";
export type { Need, Provides } from "./needs.ts";
export type { HandleState, MistHandle, NativeKind, RegistryHistory } from "./registry.ts";
export type { Reduced, Snapshot } from "./values.ts";

type Method = (...args: any[]) => unknown;

/**
 * The page's view of a native module: every method but start, stop and mist's hidden ones, each
 * returning a promise of what it returns (Electron's IPC structured-clones it on the way). A method
 * that returns a promise already keeps its own type, so a generic one keeps its type parameters,
 * which inferring its arguments and result would erase.
 */
export type NativeClient<N> = {
    [K in keyof N as K extends "start" | "stop" | HiddenMethod ? never : N[K] extends Method ? K : never]:
        N[K] extends (...args: any[]) => Promise<unknown> ? N[K]
        : N[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

/** The type of the events a native module's channel carries, or never when it has none */
export type EventsOf<N> = N extends Record<typeof HIDDEN.events, (...args: any[]) => Promise<EventsAnswer<infer E>>> ? E : never;

export interface MistLog {
    /** Vencord's Logger.log: printed with console.log */
    log(...args: unknown[]): void;
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

/** Options for the page's records of its native calls, its log and its values. Method names are the native side's. */
export interface MistOptions<N = {}> extends RecordingOptions<keyof NativeClient<N> & string> {
    /** The bus protocols this plugin provides to others, each at the version it speaks, as in `{ "weather-feed": 2 }` */
    provides?: Provides;
    /** Protocols this plugin speaks with other plugins. A plugin installed at another version is a warning, logged and toasted once. */
    needs?: readonly Need[];
}

/** One step of a plugin's settings, run once, before start, for stored settings older than `to` */
export interface Migration<S extends SettingsSchema> {
    /** The settings version this step makes: whole numbers from 1, each step its own */
    readonly to: number;
    /** Synchronous, so its writes and the version mark are saved together */
    run(settings: MigrationSettings<S>): void;
}

export interface MigrationSettings<S extends SettingsSchema> {
    /** The stored value under any key, declared or not. A declared key that was never set gives its default. */
    get(key: string): unknown;
    set<K extends keyof S & string>(key: K, value: SettingsValues<S>[K]): void;
}

/** What `mist.define` takes: Evi's plugin definition, and the settings migrations */
export type MistDefinition<S extends SettingsSchema> = PluginDefinition<S> & {
    /** Run in order of `to`, before start. The first one that throws is logged and stops the rest; the plugin still starts. */
    migrate?: readonly Migration<S>[];
};

export interface SafeOptions {
    /** The error line logged when `fn` throws, in place of "<name> threw; returning its fallback" */
    message?: string;
}

export interface Mist<S extends SettingsSchema, N> {
    readonly id: string;
    /** The plugin's context while it runs. Throws, naming the plugin, when it isn't running. */
    readonly ctx: PluginContext<S>;
    /** From start until Evi disposes the run, which is after the plugin's stop */
    readonly running: boolean;
    /** Typed native calls, recorded for `mist calls` */
    readonly native: NativeClient<N>;
    /** ctx.logger while running, recorded for `mist logs` either way */
    readonly log: MistLog;
    /** Events from the native side's channel (nativeEvents), typed from the native module */
    readonly events: MistEvents<EventsOf<N>>;
    /** Wraps the plugin's definition: keeps mist.ctx current, runs settings migrations and registers the plugin for debugging */
    define(definition: MistDefinition<S>): PluginDefinition<S>;
    /** A debug report for a bug report: versions, status, recent logs and calls, each value reduced to its type and size */
    report(): Promise<string>;
    /** Copies the report to the clipboard and, while the plugin runs, toasts whether that worked */
    copyReport(): Promise<boolean>;
    /** A slash command for `ctx.command` that copies the report, or shows it when copying fails */
    reportCommand(name?: string): CommandDefinition;
    /** Publishes a value for `mist values`. The getter runs when asked, never otherwise. */
    expose(name: string, getter: () => unknown): void;
    /**
     * A version of `fn` that never throws: it returns `fallback` instead, and logs each of the first 50
     * distinct error messages once. For `$self` patch callbacks, which run inside Discord's code.
     * A function `fallback` is called with the same `this` and arguments, so it can return Discord's
     * own value; if it throws too, the wrapper returns undefined.
     */
    safe<A extends unknown[], R>(fn: (...args: A) => R, fallback: (...args: A) => R, options?: SafeOptions): (...args: A) => R | undefined;
    safe<A extends unknown[], R>(fn: (...args: A) => R, fallback: R, options?: SafeOptions): (...args: A) => R;
}

const SEEN_MAX = 50;

/** Where the settings version is kept, among the plugin's own stored settings. Evi keeps keys a schema doesn't declare. */
export const SETTINGS_VERSION = "__mist_settingsVersion";

type UntypedSettings = { get(key: string): unknown; set(key: string, value: unknown): void; };

function ordered<S extends SettingsSchema>(migrate: readonly Migration<S>[]) {
    const steps = [...migrate].sort((a, b) => a.to - b.to);
    steps.forEach((step, i) => {
        if (!Number.isInteger(step.to) || step.to < 1 || steps[i - 1]?.to === step.to) throw new Error(`mist.define: each migration needs its own whole \`to\` from 1, not ${step.to}`);
    });
    return steps;
}

/** Logs each of the first 50 distinct line and error message pairs once */
function reporter(write: (line: string, err: unknown) => void) {
    const seen = new Set<string>();
    return (line: string, err: unknown) => {
        const key = `${line}
${errorMessage(err)}`;
        if (seen.has(key) || seen.size >= SEEN_MAX) return;
        seen.add(key);
        write(line, err);
    };
}

export function createMist<S extends SettingsSchema = {}, N = {}>(id: string, options: MistOptions<N> = {}): Mist<S, N> {
    // The event channel's long poll would push every other call out of the ring, so it's only counted
    const recorder = createRecorder({ ...options, quiet: [...options.quiet ?? [], HIDDEN.events], keepValues: true });
    const provides = options.provides ?? {};
    checkProvides(provides);
    const needs = options.needs ?? [];
    /** This run's warnings, by what they're about */
    const warnings = new Map<string, string>();
    /** Logged or toasted once per copy, not once per run */
    const told = new Set<string>();
    const exposed = new Map<string, () => unknown>();
    let current: PluginContext<S> | undefined;
    let startedAt: number | null = null;
    let unregister: (() => void) | undefined;

    const ctx = () => {
        if (!current) throw new Error(`${id} isn't running: mist.ctx only exists from start until the run is disposed`);
        return current;
    };

    function write(level: LogLevel, args: unknown[]) {
        recorder.log(level, args);
        current?.logger[level](...args);
    }
    const log: MistLog = {
        log: (...args) => write("log", args),
        debug: (...args) => write("debug", args),
        info: (...args) => write("info", args),
        warn: (...args) => write("warn", args),
        error: (...args) => write("error", args),
    };

    function callNative(method: string, args: unknown[]): Promise<unknown> {
        return recorder.track(method, args, async () => ctx().native.call(method, ...args));
    }

    const native = new Proxy({}, {
        // `then` stays undefined so the client isn't mistaken for a promise
        get: (_, method) => typeof method === "string" && method !== "then" ? (...args: unknown[]) => callNative(method, args) : undefined,
    }) as NativeClient<N>;

    const reportEvents = reporter((line, err) => log.warn(line, err));

    const debug = createDebug({ id, recorder, exposed, context: () => current, startedAt: () => startedAt, callNative, provides, warnings: () => [...warnings.values()] });
    const registered = registry();

    function storeMissed(store: string) {
        const key = `store ${store}`;
        if (warnings.has(key)) return;
        const line = `start read ${store} before Discord made it, so it got undefined. Evi starts plugins before Discord makes many stores: listen by name, as in subscribe(["${store}"], …) or useStore("${store}", …), which wait for the store.`;
        warnings.set(key, line);
        if (told.has(key)) return;
        told.add(key);
        log.warn(line);
    }

    function migrate(context: PluginContext<S>, steps: readonly Migration<S>[]) {
        if (!steps.length) return;
        const settings = context.settings as unknown as UntypedSettings;
        const stored = settings.get(SETTINGS_VERSION);
        let at = typeof stored === "number" ? stored : 0;
        const view: MigrationSettings<S> = { get: key => settings.get(key), set: (key, value) => settings.set(key, value) };
        for (const step of steps) {
            if (step.to <= at) continue;
            try {
                step.run(view);
            } catch (err) {
                const line = `Settings migration to ${step.to} threw, so it and the ones after it didn't apply. ${id} starts with its settings as they are, and the migration runs again at the next start.`;
                warnings.set("migration", line);
                log.error(line, err);
                return;
            }
            settings.set(SETTINGS_VERSION, at = step.to);
        }
    }

    function watchNeeds(context: PluginContext<S>) {
        if (!needs.length) return;
        const self = context.manifest?.name || id;
        const check = () => {
            if (current !== context) return;
            for (const key of [...warnings.keys()]) if (key.startsWith("need ")) warnings.delete(key);
            for (const mismatch of mismatches(needs, eviOf(), registered)) {
                const key = `need ${mismatch.need.plugin} ${mismatch.need.protocol}`;
                const line = describeMismatch(mismatch, self);
                warnings.set(key, line);
                if (told.has(key)) continue;
                told.add(key);
                log.warn(line);
                try { context.toast(toastFor(mismatch, self), { type: "failure" }); } catch { }
            }
        };
        check();
        // A plugin installed, updated or turned on later is judged then
        try {
            const off = eviOf()?.plugins?.subscribe?.(check);
            if (off) context.onDispose(off);
        } catch { }
    }

    return {
        id,
        get ctx() { return ctx(); },
        get running() { return !!current; },
        native,
        log,

        events: {
            subscribe(listener, options) {
                const context = ctx();
                return subscribe({
                    onDispose: fn => context.onDispose(fn),
                    poll: (boot, cursor) => recorder.track(HIDDEN.events, [boot, cursor], () => context.native.call<EventsAnswer<EventsOf<N>>>(HIDDEN.events, boot, cursor)),
                    report: reportEvents,
                }, listener as (event: EventsOf<N>) => void, options);
            },
        },

        define({ migrate: migrations = [], ...definition }) {
            const start = definition.start;
            const steps = ordered(migrations);
            unregister?.();
            unregister = registered.register(debug.handle);
            return {
                ...definition,
                start(this: PluginDefinition<S>, context: PluginContext<S>) {
                    current = context;
                    startedAt = Date.now();
                    if (context.id !== id) log.warn(`createMist("${id}") runs as ${context.id}: \`mist\` commands know it as ${id}. Use the id from manifest.json.`);
                    // Another handle may have taken the id while the plugin was stopped
                    if (registered.get(id) !== debug.handle) {
                        unregister = registered.register(debug.handle);
                        if (registered.get(id) !== debug.handle) log.warn(`Another handle holds ${id} in the debug registry and says it is running, so \`mist\` can't reach this run`);
                    }
                    context.onDispose(() => {
                        if (current !== context) return;
                        current = undefined;
                        startedAt = null;
                    });
                    void debug.probe(context);
                    warnings.clear();
                    migrate(context, steps);
                    const started = whileStarting(storeMissed, () => start?.call(this, context));
                    watchNeeds(context);
                    return started;
                },
            };
        },

        report: () => buildReport(debug.handle, registered),

        async copyReport() {
            const copied = await copyText(await buildReport(debug.handle, registered));
            try {
                current?.toast(copied ? "Copied the debug report. Paste it into your bug report." : "Couldn't copy the debug report.", { type: copied ? "success" : "failure" });
            } catch { }
            return copied;
        },

        reportCommand(name = `${id}-report`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32)) {
            return {
                name,
                description: `Copies ${id}'s debug report, to paste into a bug report`,
                async execute() {
                    const text = await buildReport(debug.handle, registered);
                    if (await copyText(text)) return { ephemeral: "Copied the debug report. Paste it into your bug report." };
                    return { ephemeral: `Couldn't copy the debug report. Here it is:\n\`\`\`\n${text}\n\`\`\`` };
                },
            };
        },

        expose(name, getter) {
            exposed.set(name, getter);
        },

        safe: function safe(fn: Method, fallback: unknown, options: SafeOptions = {}) {
            const name = fn.name || "A patch callback";
            const report = reporter((line, err) => log.error(line, err));
            return function (this: unknown, ...args: unknown[]) {
                try {
                    return fn.apply(this, args);
                } catch (err) {
                    report(options.message ?? `${name} threw; returning its fallback`, err);
                }
                if (typeof fallback !== "function") return fallback;
                try {
                    return fallback.apply(this, args);
                } catch (err) {
                    report(`${name}'s fallback threw; returning undefined`, err);
                    return undefined;
                }
            };
        } as Mist<S, N>["safe"],
    };
}
