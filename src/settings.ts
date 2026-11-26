/** A plugin's settings on the page: `mist.settings`, `mist.data` and settings migrations. */
import type { PluginContext, SettingsSchema, SettingsValues } from "@evi/api";
import { useSyncExternalStore } from "react";

import { attempt, checkNumber, jsonText, notifyEach, shownValue } from "./internal.ts";
import type { ChangeSource } from "./stores.ts";

/**
 * The plugin's settings, readable at any time: between runs they are the schema's defaults and
 * writes do nothing. A ChangeSource: `useStore([mist.settings], ...)` follows it.
 */
export interface MistSettings<S extends SettingsSchema> extends ChangeSource {
    get<K extends keyof S & string>(key: K): SettingsValues<S>[K];
    set<K extends keyof S & string>(key: K, value: SettingsValues<S>[K]): void;
    /** A copy of every value */
    all(): SettingsValues<S>;
    /** Calls `listener` with the values whenever one changes, in any run, until the returned function is called */
    onChange(listener: (values: SettingsValues<S>) => void): () => void;
    /** React hook: the key's value, re-rendering only when it changes */
    use<K extends keyof S & string>(key: K): SettingsValues<S>[K];
}

/**
 * A typed value kept with the plugin's settings. Between runs it reads `initial` and writes do
 * nothing. Shaped like MistSettings and ui's State, and a ChangeSource: `useStore([data], ...)`,
 * `subscribe(data, ...)` and `useValue(data)` all take it.
 */
export interface MistData<T> extends ChangeSource {
    get(): T;
    /** Stores a JSON copy of `value`: changing the object afterwards changes nothing stored. Throws a TypeError for a value JSON can't hold. */
    set(value: T): void;
    update(fn: (current: T) => T): void;
    /** React hook: the value, re-rendering when it changes */
    use(): T;
    /** Calls `listener` with the value whenever it changes, until the returned function is called */
    onChange(listener: (value: T) => void): () => void;
}

export interface DataOptions<T> {
    /**
     * Turns the stored JSON into a T, as when an older version stored another shape. Runs once per
     * stored value. When it throws, the value reads as `initial` and the error is logged.
     */
    parse?(raw: unknown): T;
}

/** One step of a plugin's settings, run once, before start, for stored settings older than `to` */
export interface Migration<S extends SettingsSchema> {
    /** The settings version this step makes: distinct whole numbers from 1 */
    readonly to: number;
    /** Synchronous: its writes and the version mark are saved together */
    run(settings: MigrationSettings<S>): void;
}

export interface MigrationSettings<S extends SettingsSchema> {
    /** The stored value under any key, declared or not. A declared key that was never set gives its default. */
    get(key: string): unknown;
    set<K extends keyof S & string>(key: K, value: SettingsValues<S>[K]): void;
}

/** Where the settings version is kept, among the plugin's stored settings. Evi keeps keys a schema doesn't declare. */
export const SETTINGS_VERSION = "__mist_settingsVersion";

const DATA_PREFIX = "__mist_data:";

export interface SettingsSource<S extends SettingsSchema> {
    context(): PluginContext<S> | undefined;
    /** A listener or a parse threw */
    report(line: string, err: unknown): void;
    /** Something wrote between runs, which does nothing */
    idle(what: string): void;
}

interface UntypedSettings { get(key: string): unknown; set(key: string, value: unknown): void; }

/** Reads and writes keys the schema doesn't declare, which Evi stores all the same */
function untyped<S extends SettingsSchema>(context: PluginContext<S>): UntypedSettings {
    type Key = keyof S & string;
    const settings = context.settings;
    return {
        get: key => settings.get(key as Key),
        set: (key, value) => settings.set(key as Key, value as SettingsValues<S>[Key]),
    };
}

/** Listeners told of a change, each guarded from the others */
function changeHub(onError: (err: unknown) => void) {
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
    };
    return {
        notify: () => notifyEach(listeners, [], (_, err) => onError(err)),
        subscribe,
        addChangeListener: (listener: () => void) => void listeners.add(listener),
        removeChangeListener: (listener: () => void) => void listeners.delete(listener),
    };
}

export function defaultsOf<S extends SettingsSchema>(schema: S | undefined): SettingsValues<S> {
    return Object.fromEntries(Object.entries(schema ?? {}).map(([key, setting]) => [key, setting.default])) as SettingsValues<S>;
}

/** Setting values are primitives: equal key by key is equal */
function sameValues(a: object, b: object) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(right);
    return keys.length === Object.keys(left).length && keys.every(key => Object.is(left[key], right[key]));
}

/** `mist.settings`. Call `changed` when the values may have changed: a settings write, a start, a stop. */
export function createSettings<S extends SettingsSchema>(source: SettingsSource<S> & { defaults(): SettingsValues<S>; }) {
    const changes = changeHub(err => source.report("A settings listener threw", err));

    let last: SettingsValues<S> | undefined;
    /** The values, the same object until one changes */
    const values = (): SettingsValues<S> => {
        const context = source.context();
        const next = context ? context.settings.all : source.defaults();
        if (last && sameValues(last, next)) return last;
        return last = next;
    };
    const get = <K extends keyof S & string>(key: K): SettingsValues<S>[K] => {
        const context = source.context();
        return context ? context.settings.get(key) : source.defaults()[key];
    };

    const settings: MistSettings<S> = {
        get,
        set(key, value) {
            const context = source.context();
            if (context) context.settings.set(key, value);
            else source.idle("mist.settings.set");
        },
        all: () => ({ ...values() }),
        onChange(listener) {
            let seen = values();
            return changes.subscribe(() => {
                const now = values();
                if (now === seen) return;
                seen = now;
                listener({ ...now });
            });
        },
        use: key => useSyncExternalStore(changes.subscribe, () => get(key)),
        addChangeListener: changes.addChangeListener,
        removeChangeListener: changes.removeChangeListener,
    };
    return { settings, changed: changes.notify };
}

/** `mist.data`. Call `changed` when a run starts or stops. */
export function createData<S extends SettingsSchema>(source: SettingsSource<S>) {
    const changes = changeHub(err => source.report("A data listener threw", err));

    function data<T>(key: string, initial: T, { parse }: DataOptions<T> = {}): MistData<T> {
        const stored = DATA_PREFIX + key;
        const initialJson = attempt(() => JSON.stringify(initial));
        /**
         * The stored value as read, the same object until the stored one changes: what use() gives
         * React. Made from the stored JSON, never Evi's stored object, so no caller holds that object
         * and set's comparison with it stays true.
         */
        let kept: { raw: unknown; json: string; value: T; } | undefined;

        const storedRaw = () => {
            const context = source.context();
            return context ? untyped(context).get(stored) : undefined;
        };
        const snapshot = (): T => {
            const raw = storedRaw();
            if (raw === undefined) return initial;
            if (kept?.raw === raw) return kept.value;
            const json = JSON.stringify(raw);
            if (json === undefined) return initial;
            if (kept?.json === json) {
                kept.raw = raw;
                return kept.value;
            }
            let value: T;
            try {
                value = parse ? parse(JSON.parse(json)) : JSON.parse(json) as T;
            } catch (err) {
                source.report(`mist.data: parse threw for ${shownValue(key)}; reading the initial value`, err);
                value = initial;
            }
            kept = { raw, json, value };
            return value;
        };
        /** A copy of the value for each read, so changing it in place changes neither what's stored nor the next read. A parse's value is shared between reads. */
        const get = (): T => {
            const value = snapshot();
            if (parse || typeof value !== "object" || value === null) return value;
            let json: string | undefined;
            if (value === kept?.value) json = kept.json;
            else if (initialJson.ok) json = initialJson.value;
            return json === undefined ? value : JSON.parse(json) as T;
        };
        const set = (value: T) => {
            const json = jsonText(`mist.data: ${shownValue(key)}`, value);
            const context = source.context();
            if (!context) return source.idle("mist.data.set");
            const settings = untyped(context);
            const raw = settings.get(stored);
            if (raw !== undefined && JSON.stringify(raw) === json) return;
            settings.set(stored, JSON.parse(json));
            changes.notify();
        };

        return {
            get,
            set,
            update: fn => set(fn(get())),
            use: () => useSyncExternalStore(changes.subscribe, snapshot),
            onChange(listener) {
                let seen = snapshot();
                return changes.subscribe(() => {
                    const now = snapshot();
                    if (Object.is(now, seen)) return;
                    seen = now;
                    listener(get());
                });
            },
            addChangeListener: changes.addChangeListener,
            removeChangeListener: changes.removeChangeListener,
        };
    }
    return { data, changed: changes.notify };
}

/** The steps in order of `to`. Throws for a `to` that isn't a whole number from 1, or one used twice. */
export function orderMigrations<S extends SettingsSchema>(migrate: readonly Migration<S>[]): Migration<S>[] {
    const steps = [...migrate].sort((a, b) => a.to - b.to);
    steps.forEach((step, i) => {
        checkNumber("mist.define", "migration to", step.to, { min: 1, integer: true });
        if (steps[i - 1]?.to === step.to) throw new RangeError(`mist.define: each migration's \`to\` must be distinct, got ${step.to} twice`);
    });
    return steps;
}

/** Runs the steps newer than the stored version, marking each. Returns the step that threw, which stops the rest. */
export function runMigrations<S extends SettingsSchema>(context: PluginContext<S>, steps: readonly Migration<S>[]): { to: number; err: unknown; } | undefined {
    if (!steps.length) return undefined;
    const stored = untyped(context);
    const version = stored.get(SETTINGS_VERSION);
    const view: MigrationSettings<S> = { get: key => stored.get(key), set: (key, value) => stored.set(key, value) };
    for (const step of steps) {
        if (typeof version === "number" && step.to <= version) continue;
        try {
            step.run(view);
        } catch (err) {
            return { to: step.to, err };
        }
        stored.set(SETTINGS_VERSION, step.to);
    }
    return undefined;
}
