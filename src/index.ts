/** `@aurologic/mist-api`: the page side of a plugin. */
import type { CommandDefinition, PluginContext, PluginDefinition, SettingsSchema, SettingsValues } from "@evi/api";

import { createNativeClient, type NativeClient } from "./client.ts";
import { createDebug } from "./debug.ts";
import { createFlux, type MistFlux } from "./flux.ts";
import { createLogOnce, type Method, onEnd } from "./internal.ts";
import { checkProvides, describeMismatch, mismatches, type Need, type Provides, toastFor } from "./needs.ts";
import { claimMist } from "./permissions.ts";
import { type EventsAnswer, HIDDEN, type LogLevel, type RequestEvent } from "./protocol.ts";
import { createRecorder, type RecordingOptions } from "./recorder.ts";
import { eviOf, registry } from "./registry.ts";
import { createRequests, type MistRequests, type RequestsOf } from "./replies.ts";
import { buildReport, copyText } from "./report.ts";
import { checkSelf } from "./self.ts";
import { createData, createSettings, type DataOptions, defaultsOf, type Migration, type MistData, type MistSettings, orderMigrations, runMigrations } from "./settings.ts";
import { whileStarting } from "./start.ts";
import { createStorage, type PluginStorage } from "./storage.ts";
import { type MistEvents, subscribe } from "./subscribe.ts";

export { onDemand } from "./patches.ts";
export { MistNativeError } from "./errors.ts";
export type { CallOptions, NativeClient, NativeFunction } from "./client.ts";
export type { MistFlux, NextOptions } from "./flux.ts";
export type { MistRequests, RequestsOf } from "./replies.ts";
export { MIST_VERSION } from "./protocol.ts";
export type { CallOutcome, CallRecord, EventsAnswer, LogLevel, LogRecord, NativeLogs, ReducedNativeLogs, Shown } from "./protocol.ts";
export type { MistEvents, SubscribeOptions } from "./subscribe.ts";
export type { MistCapability } from "./debug.ts";
export type { Need, Provides } from "./needs.ts";
export type { HandleState, MistHandle, NativeKind, RegistryHistory } from "./registry.ts";
export type { Reduced, Snapshot } from "./values.ts";
export type { KeyValueStore, PluginStorage } from "./storage.ts";
export { SETTINGS_VERSION } from "./settings.ts";
export type { DataOptions, Migration, MigrationSettings, MistData, MistSettings } from "./settings.ts";

/** The type of the events a native module's channel carries, or never when it has none */
export type EventsOf<N> = N extends Record<typeof HIDDEN.events, (...args: any[]) => Promise<EventsAnswer<infer E>>> ? E : never;

export interface MistLog {
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

/** What `mist.define` takes: Evi's plugin definition, and the settings migrations */
export type MistDefinition<S extends SettingsSchema> = PluginDefinition<S> & {
    /** Run in order of `to`, before start. The first one that throws is logged and stops the rest; the plugin still starts. */
    migrate?: readonly Migration<S>[];
};

/** What `mist.define` returns: Evi's plugin definition, always with a start */
export type DefinedPlugin<S extends SettingsSchema> = PluginDefinition<S> & { start: NonNullable<PluginDefinition<S>["start"]>; };

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
    /** Typed native calls, recorded for `mist calls`. `mist.native.method.with({ signal })(...args)` makes a call that can be aborted. */
    readonly native: NativeClient<N>;
    /** Answers to the native side's requests (nativeRequests), typed from the native module */
    readonly requests: MistRequests<RequestsOf<N>>;
    /** ctx.logger while running, recorded for `mist logs` either way */
    readonly log: MistLog;
    /** Events from the native side's channel (nativeEvents), typed from the native module */
    readonly events: MistEvents<EventsOf<N>>;
    /** Aborts when the current run stops. A fresh signal each start; read between runs, it is already aborted. */
    readonly signal: AbortSignal;
    /** ctx.toast while running; does nothing between runs */
    toast(...args: Parameters<PluginContext<S>["toast"]>): void;
    /** The plugin's key-value store in IndexedDB, kept between runs and restarts */
    readonly storage: PluginStorage;
    /** The settings from the schema passed to `define`, safe to read between runs */
    readonly settings: MistSettings<S>;
    /** A typed value under `key`, kept with the plugin's settings but outside its schema */
    data<T>(key: string, initial: T, options?: DataOptions<T>): MistData<T>;
    readonly flux: MistFlux;
    /**
     * Wraps the plugin's definition: keeps mist.ctx current, runs settings migrations and registers the plugin for debugging.
     * Warns about `$self` names in string patch replacements that the definition has no function for.
     */
    define(definition: MistDefinition<S>): DefinedPlugin<S>;
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
     * value; if it throws too, the wrapper returns undefined.
     */
    safe<A extends unknown[], R>(fn: (...args: A) => R, fallback: (...args: A) => R, options?: SafeOptions): (...args: A) => R | undefined;
    safe<A extends unknown[], R>(fn: (...args: A) => R, fallback: R, options?: SafeOptions): (...args: A) => R;
}

const COPIED = "Copied the debug report. Paste it into your bug report.";

export function createMist<S extends SettingsSchema = {}, N = {}>(id: string, options: MistOptions<N> = {}): Mist<S, N> {
    // The long polls would push every other call out of the ring: they're only counted
    const recorder = createRecorder({ ...options, quiet: [...options.quiet ?? [], HIDDEN.events, HIDDEN.requests], keepValues: true });
    const provides = options.provides ?? {};
    checkProvides(provides);
    const needs = options.needs ?? [];
    /** This run's warnings, by what they're about */
    const warnings = new Map<string, string>();
    /** Keys logged or toasted once per copy, not once per run */
    const told = new Set<string>();
    const exposed = new Map<string, () => unknown>();
    let current: PluginContext<S> | undefined;
    let startedAt: number | null = null;
    let run: AbortController | undefined;
    let defaults = {} as SettingsValues<S>;
    const stopped = () => new DOMException(`${id} stopped`, "AbortError");

    const ctx = () => {
        if (!current) throw new Error(`mist.ctx: ${id} isn't running; the context exists from start until the run is disposed`);
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

    /** Runs `tell` the first time `key` comes up in this copy. Returns whether it ran. */
    const once = (key: string, tell: () => void) => {
        if (told.has(key)) return false;
        told.add(key);
        tell();
        return true;
    };
    /** Adds a warning to this run's status, and logs it the first time in this copy. Returns whether it logged. */
    const warn = (key: string, line: string) => {
        warnings.set(key, line);
        return once(key, () => log.warn(line));
    };
    const idle = (what: string) => once(`idle ${what}`, () => log.debug(`${what}: ignored while ${id} is stopped`));

    const client = createNativeClient({ context: ctx, track: (method, args, run) => recorder.track(method, args, run) });
    const native = client.native as NativeClient<N>;

    const reportEvents = createLogOnce(log.warn, "mist.events");
    const requests = createRequests<RequestsOf<N>>({
        context: ctx,
        protocol: client.protocol,
        poll: (context, boot, cursor) => recorder.track(HIDDEN.requests, [boot, cursor], () => context.native.call<EventsAnswer<RequestEvent> | null>(HIDDEN.requests, boot, cursor)),
        report: createLogOnce(log.warn, "mist.requests"),
    });

    const debug = createDebug({
        id, recorder, exposed, provides,
        context: () => current,
        startedAt: () => startedAt,
        callNative: (method, args) => client.call(method, args),
        warnings: () => [...warnings.values()],
        owns: value => value === mist,
    });
    const registered = registry();
    // At creation, not at define: `discord(mist)` and the UI registries check ownership through it
    registered.register(debug.handle);

    const { settings, changed: settingsChanged } = createSettings<S>({
        context: () => current,
        report: createLogOnce(log.error, "mist.settings"),
        idle,
        defaults: () => defaults,
    });
    const { data, changed: dataChanged } = createData<S>({
        context: () => current,
        report: createLogOnce(log.error, "mist.data"),
        idle,
    });
    /** Between runs every value reads as its default: a start or a stop can change any of them */
    const runChanged = () => {
        settingsChanged();
        dataChanged();
    };

    const flux = createFlux({ context: () => current, signal: () => mist.signal, idle });

    function storeMissed(store: string) {
        warn(`store ${store}`, `start read ${store} before Discord made it and got undefined. Wait for it by name: subscribe(["${store}"], …) or useStore("${store}", …).`);
    }

    function watchNeeds(context: PluginContext<S>) {
        if (!needs.length) return;
        const self = context.manifest?.name || id;
        const check = () => {
            if (current !== context) return;
            for (const key of [...warnings.keys()]) if (key.startsWith("need ")) warnings.delete(key);
            for (const mismatch of mismatches(needs, eviOf(), registered)) {
                if (!warn(`need ${mismatch.need.plugin} ${mismatch.need.protocol}`, describeMismatch(mismatch, self))) continue;
                try { context.toast(toastFor(mismatch, self), { type: "failure" }); } catch { }
            }
        };
        check();
        // A plugin installed, updated or turned on later is judged then
        try {
            const off = eviOf()?.plugins?.subscribe?.(check);
            if (off) context.onDispose(off);
        } catch (err) {
            log.warn("Couldn't follow Evi's plugin list; needs are only checked at start", err);
        }
    }

    /** Points mist at `context` until Evi disposes it */
    function begin(context: PluginContext<S>) {
        current = context;
        startedAt = Date.now();
        if (context.id !== id) log.warn(`createMist("${id}") runs as ${context.id}, and \`mist\` commands know it as ${id}. Use the id from manifest.json.`);
        // Another handle may have taken the id while the plugin was stopped
        if (registered.get(id) !== debug.handle) {
            registered.register(debug.handle);
            if (registered.get(id) !== debug.handle) log.warn(`Another running handle holds ${id} in the debug registry: \`mist\` can't reach this run`);
        }
        run?.abort(stopped());
        const mine = run = new AbortController();
        context.onDispose(() => {
            if (current === context) {
                current = undefined;
                startedAt = null;
                runChanged();
            }
            mine.abort(stopped());
        });
        void debug.probe(context);
        warnings.clear();
    }

    const mist: Mist<S, N> = {
        id,
        get ctx() { return ctx(); },
        get running() { return !!current; },
        native,
        requests,
        log,
        settings,
        data,
        flux,

        get signal() { return current && run ? run.signal : AbortSignal.abort(stopped()); },
        toast(...args) { current?.toast(...args); },
        storage: createStorage(id),

        events: {
            subscribe(listener, options) {
                const context = ctx();
                return subscribe({
                    onDispose: fn => onEnd(context, fn),
                    poll: (boot, cursor) => recorder.track(HIDDEN.events, [boot, cursor], () => context.native.call<EventsAnswer<EventsOf<N>>>(HIDDEN.events, boot, cursor)),
                    report: reportEvents,
                }, listener as (event: EventsOf<N>) => void, options);
            },
        },

        define({ migrate = [], ...definition }) {
            const pluginStart = definition.start;
            const steps = orderMigrations(migrate);
            defaults = defaultsOf(definition.settings);
            const wrapped: DefinedPlugin<S> = { ...definition, start };
            // Evi's $self is the returned object, with the wrapper's start
            const selfProblems = checkSelf(wrapped);

            function start(this: PluginDefinition<S>, context: PluginContext<S>) {
                begin(context);
                for (const line of selfProblems) warn(`self ${line}`, line);
                const failed = runMigrations(context, steps);
                if (failed) {
                    const line = `Settings migration to ${failed.to} threw; it and later ones run again at the next start.`;
                    warnings.set("migration", line);
                    log.error(line, failed.err);
                }
                // Contexts built by hand, as tests build them, may leave onChange out
                if (typeof context.settings?.onChange === "function") context.settings.onChange(settingsChanged);
                runChanged();
                const started = whileStarting(storeMissed, () => pluginStart?.call(this, context));
                watchNeeds(context);
                return started;
            }
            return wrapped;
        },

        report: () => buildReport(debug.handle, registered),

        async copyReport() {
            const copied = await copyText(await buildReport(debug.handle, registered));
            try {
                current?.toast(copied ? COPIED : "Couldn't copy the debug report.", { type: copied ? "success" : "failure" });
            } catch { }
            return copied;
        },

        reportCommand(name = `${id}-report`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32)) {
            return {
                name,
                description: `Copies ${id}'s debug report, to paste into a bug report`,
                async execute() {
                    const text = await buildReport(debug.handle, registered);
                    if (await copyText(text)) return { ephemeral: COPIED };
                    return { ephemeral: `Couldn't copy the debug report. Here it is:\n\`\`\`\n${text}\n\`\`\`` };
                },
            };
        },

        expose(name, getter) {
            exposed.set(name, getter);
        },

        safe: function safe(fn: Method, fallback: unknown, options: SafeOptions = {}) {
            const name = fn.name || "A patch callback";
            const report = createLogOnce(log.error, `mist.safe(${name})`);
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
    claimMist(mist, id);
    return mist;
}
