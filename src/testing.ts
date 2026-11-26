/**
 * `@aurologic/mist-api/testing`: test doubles for a plugin's unit tests, for any test runner. A
 * fake plugin context, a fake Flux store, and fake `@evi/api` and `electron` modules for the runner's module mock.
 */
import type { Filter, FluxAction, FluxDispatcher, FoundExport, PluginContext, SettingsSchema, SettingsValues } from "@evi/api";

import type { LogLevel } from "./protocol.ts";

export type { LogLevel } from "./protocol.ts";
export {
    type FakeBrowserWindow, type FakeBrowserWindowClass, type FakeCookie, type FakeCookieDetails, type FakeCookies, fakeElectron, type FakeElectron,
    type FakeElectronModule, type FakeElectronOptions, type FakeSession, type FakeWebContents, type PermissionCheckHandler, type PermissionRequestHandler, type Rect,
} from "./fake-electron.ts";

type EviApi = typeof import("@evi/api");

/** A Flux store: `state`'s fields, change listeners, and change() to update it and notify them */
export type FakeStore<T extends object> = T & {
    addChangeListener(listener: () => void): void;
    removeChangeListener(listener: () => void): void;
    /** Assigns `next` to the store, then calls each listener, as a Flux store's emitChange does */
    change(next?: Partial<T>): void;
    /** The listeners now added */
    readonly listeners: Set<() => void>;
};

export function fakeStore<T extends object>(state: T): FakeStore<T> {
    const listeners = new Set<() => void>();
    return Object.assign(state, {
        addChangeListener: (listener: () => void) => void listeners.add(listener),
        removeChangeListener: (listener: () => void) => void listeners.delete(listener),
        change(next: Partial<T> = {}) {
            Object.assign(state, next);
            for (const listener of [...listeners]) listener();
        },
        listeners,
    });
}

/** Discord's Flux dispatcher: dispatch() calls the handlers subscribed to the action's type, at once */
export interface FakeDispatcher extends FluxDispatcher {
    /** Every action dispatched, oldest first */
    readonly dispatched: FluxAction[];
}

export function fakeDispatcher(): FakeDispatcher {
    const handlers = new Map<string, Set<(action: FluxAction) => void>>();
    const dispatched: FluxAction[] = [];
    return {
        dispatched,
        subscribe(type, handler) {
            let set = handlers.get(type);
            if (!set) handlers.set(type, set = new Set());
            set.add(handler);
        },
        unsubscribe: (type, handler) => void handlers.get(type)?.delete(handler),
        async dispatch(action) {
            dispatched.push(action);
            for (const handler of [...handlers.get(action.type) ?? []]) handler(action);
        },
    };
}

/** What a test's module mock returns for `@evi/api`: the parts of it that mist-api uses */
export interface FakeEviModule {
    findStore: EviApi["findStore"];
    getStore: EviApi["getStore"];
    waitFor: EviApi["waitFor"];
    /** byProps and byCode test the value as Evi's do; byStoreName takes the store added under that name */
    filters: Pick<EviApi["filters"], "byStoreName" | "byProps" | "byCode">;
    /** The first added store or export the filter takes */
    find: EviApi["find"];
    /** Every added store and export the filter takes */
    findAll: EviApi["findAll"];
    /** Discord's language, `"en-US"` until a test sets `discordLocale` */
    I18n: { discordLocale: string; };
    Dispatcher: FakeDispatcher;
    /** The React passed to fakeEvi, for code that imports React from @evi/api */
    React: EviApi["React"];
    /** Evi's Components, empty: mist's Button and Tip render their fallback. Set `Button` or `Tooltip` on it to render a stand-in for Discord's. */
    Components: Record<string, unknown>;
}

export interface FakeEvi {
    /** Return this from the module mock: `mock.module("@evi/api", () => evi.module)` */
    readonly module: FakeEviModule;
    /** Makes Discord's store `name`, and calls back each waitFor whose filter takes it */
    addStore(name: string, store: object): void;
    removeStore(name: string): void;
    /** Adds a module export that find and findAll search, as Discord's webpack exports are */
    addExport(value: unknown): void;
    /** While false, findStore and getStore throw, as Evi's do before Discord's webpack has loaded */
    ready: boolean;
    /** Each name findStore and getStore were asked for, oldest first */
    readonly lookups: string[];
    /** Evi's plugin list, as `window.Evi.plugins` gives it */
    readonly plugins: FakePlugins;
    /** Adds the installed plugin `id`, or replaces it, and calls the plugin list's subscribers */
    setPlugin(id: string, plugin?: FakePlugin): void;
    removePlugin(id: string): void;
    /**
     * Sets `globalThis.Evi` to `{ plugins, settings }` for code that reads `window.Evi`. Returns a
     * function that puts back what was there.
     */
    installGlobal(): () => void;
}

/** An installed plugin as Evi's plugin list reports it */
export interface FakePlugin {
    /** Default the id */
    name?: string;
    version?: string;
    /** Default true */
    running?: boolean;
    /** Default true */
    evaluated?: boolean;
    error?: string;
    enabledByDefault?: boolean;
    /** The plugin's switch in Evi's settings. Default true */
    enabled?: boolean;
}

export interface FakePluginInfo {
    running: boolean;
    evaluated: boolean;
    error?: string;
    manifest: { name: string; version?: string; enabledByDefault?: boolean; };
}

export interface FakePlugins {
    get(id: string): FakePluginInfo | undefined;
    subscribe(listener: () => void): () => void;
    /** The listeners now subscribed */
    readonly listeners: Set<() => void>;
}

function matchesCode(fn: Function, code: (string | RegExp)[]) {
    let source: string;
    try {
        source = Function.prototype.toString.call(fn);
    } catch {
        return false;
    }
    return code.every(c => {
        if (typeof c === "string") return source.includes(c);
        c.lastIndex = 0;
        return c.test(source);
    });
}

export interface FakeEviOptions {
    /** React for code that imports it from @evi/api. Without it, reading module.React throws, and spreading module leaves React out. */
    React?: EviApi["React"];
}

export function fakeEvi(options: FakeEviOptions = {}): FakeEvi {
    const stores = new Map<string, object>();
    const exported: unknown[] = [];
    const takes = (filter: (value: any) => unknown, value: unknown) => {
        try {
            return !!filter(value);
        } catch {
            return false;
        }
    };
    const searched = () => [...stores.values(), ...exported];
    const lookups: string[] = [];
    const waiting = new Set<{ filter: Filter; callback: (value: any, found: FoundExport) => void; }>();
    const found = (name: string, value: object): FoundExport => ({ id: `fake:${name}`, exports: value, key: undefined, value });
    const installed = new Map<string, FakePlugin>();
    const pluginListeners = new Set<() => void>();
    const pluginsChanged = () => { for (const listener of [...pluginListeners]) listener(); };
    const plugins: FakePlugins = {
        get(id) {
            const plugin = installed.get(id);
            if (!plugin) return undefined;
            const { name = id, version, running = true, evaluated = true, error, enabledByDefault } = plugin;
            return {
                running,
                evaluated,
                ...error !== undefined && { error },
                manifest: { name, ...version !== undefined && { version }, ...enabledByDefault !== undefined && { enabledByDefault } },
            };
        },
        subscribe(listener) {
            pluginListeners.add(listener);
            return () => void pluginListeners.delete(listener);
        },
        listeners: pluginListeners,
    };
    const settings = {
        get data() {
            return { plugins: Object.fromEntries([...installed].map(([id, plugin]) => [id, { enabled: plugin.enabled ?? true }])) };
        },
    };
    const evi: FakeEvi = {
        ready: true,
        lookups,
        plugins,
        setPlugin(id, plugin = {}) {
            installed.set(id, plugin);
            pluginsChanged();
        },
        removePlugin(id) {
            if (installed.delete(id)) pluginsChanged();
        },
        installGlobal() {
            const root = globalThis as { Evi?: unknown; };
            const had = Object.hasOwn(root, "Evi"), before = root.Evi;
            root.Evi = { plugins, settings };
            return () => {
                if (had) root.Evi = before;
                else delete root.Evi;
            };
        },
        addStore(name, store) {
            stores.set(name, store);
            for (const waiter of [...waiting]) {
                if (!takes(waiter.filter, store)) continue;
                waiting.delete(waiter);
                waiter.callback(store, found(name, store));
            }
        },
        removeStore: name => void stores.delete(name),
        addExport: value => void exported.push(value),
        module: {
            findStore: <T>(name: string) => {
                lookups.push(name);
                if (!evi.ready) throw new Error("webpack isn't ready");
                return stores.get(name) as T | undefined;
            },
            getStore: <T>(name: string) => {
                const store = evi.module.findStore<T>(name);
                if (store === undefined) throw new Error(`Couldn't find store ${name}`);
                return store;
            },
            filters: {
                byStoreName: name => Object.assign((value: unknown) => value !== undefined && stores.get(name) === value, { $label: `store ${name}` }),
                byProps: (...props) => Object.assign((value: any) => value != null && props.every(p => value[p] !== undefined), { $label: `props ${props.join(", ")}` }),
                byCode: (...code) => Object.assign((value: unknown) => typeof value === "function" && matchesCode(value, code), { $label: `code ${code.map(String).join(", ")}`, $code: code }),
            },
            waitFor: (filter, callback) => {
                for (const [name, store] of stores) if (takes(filter, store)) {
                    callback(store as never, found(name, store));
                    return () => { };
                }
                const waiter = { filter, callback };
                waiting.add(waiter);
                return () => void waiting.delete(waiter);
            },
            find: (filter => searched().find(value => takes(filter, value))) as EviApi["find"],
            findAll: (filter => searched().filter(value => takes(filter, value))) as EviApi["findAll"],
            I18n: { discordLocale: "en-US" },
            Dispatcher: fakeDispatcher(),
            get React() {
                if (!options.React) throw new Error("fakeEvi was made without React: pass fakeEvi({ React })");
                return options.React;
            },
            Components: {},
        },
    };
    // Hidden when missing: `{ ...evi.module, x }` leaves it out instead of throwing
    if (!options.React) Object.defineProperty(evi.module, "React", { enumerable: false });
    return evi;
}

export type FakeNative = (method: string, ...args: unknown[]) => Promise<unknown>;

export interface FakeContextOptions<S extends SettingsSchema> {
    id?: string;
    /** The plugin's settings schema, for the defaults of settings.get and settings.all */
    schema?: S;
    /** Stored setting values. ctx.settings.set writes into this object: passing it to the next fakeContext starts again with the same settings, as after a restart. */
    settings?: Partial<SettingsValues<S>> & Record<string, unknown>;
    /** Answers ctx.native.call. Without it, ctx.native.call throws as Evi's does for a plugin without a native module. */
    native?: FakeNative;
    /** The @evi/api that ctx.waitFor and ctx.flux use; a fresh fakeEvi() when left out */
    evi?: FakeEvi;
    /** Replaces members of the context, such as hook, which the fake only stubs */
    overrides?: Partial<Record<keyof PluginContext<S>, unknown>>;
}

export interface FakeContext<S extends SettingsSchema> {
    ctx: PluginContext<S>;
    /** What the plugin logged through ctx.logger, oldest first */
    logs: { level: LogLevel; args: unknown[]; }[];
    /** The CSS of each ctx.addStyle not removed yet */
    readonly styles: string[];
    /** What the plugin passed to ctx.toast */
    toasts: unknown[];
    evi: FakeEvi;
    /** What Evi does on stop: runs the disposers, newest first. A disposer added after this runs at once. */
    dispose(): void;
    readonly disposed: boolean;
}

/** A plugin's context, as Evi gives it to start(), recording what the plugin does with it */
export function fakeContext<S extends SettingsSchema = SettingsSchema>(options: FakeContextOptions<S> = {}): FakeContext<S> {
    const { id = "test", schema = {} as S, native, evi = fakeEvi(), overrides = {} } = options;
    const logs: FakeContext<S>["logs"] = [];
    const toasts: unknown[] = [];
    const styles: { css: string; }[] = [];
    const disposers: (() => void)[] = [];
    let disposed = false;

    const logger = Object.fromEntries((["log", "debug", "info", "warn", "error"] as const).map(level =>
        [level, (...args: unknown[]) => void logs.push({ level, args })]));
    const onDispose = (fn: () => void) => {
        if (!disposed) disposers.push(fn);
        else run(fn);
        return fn;
    };
    const run = (fn: () => void) => {
        try {
            fn();
        } catch (err) {
            logs.push({ level: "error", args: ["Cleanup threw", err] });
        }
    };

    const stored: Record<string, unknown> = options.settings ?? {};
    const changed = new Set<() => void>();
    const all = () => Object.fromEntries([...new Set([...Object.keys(schema), ...Object.keys(stored)])]
        .map(key => [key, key in stored ? stored[key] : schema[key]?.default])) as SettingsValues<S>;
    let current = all();
    const snapshot = () => {
        const next = all();
        const same = Object.keys(next).length === Object.keys(current).length && Object.entries(next).every(([k, v]) => Object.is((current as Record<string, unknown>)[k], v));
        return same ? current : current = next;
    };
    const settings = {
        schema,
        get: (key: string) => all()[key],
        set(key: string, value: unknown) {
            stored[key] = value;
            for (const listener of [...changed]) listener();
        },
        get all() { return all(); },
        snapshot,
        onChange(callback: (values: SettingsValues<S>) => void) {
            let last = snapshot();
            const listener = () => {
                if (snapshot() === last) return;
                last = snapshot();
                callback(all());
            };
            changed.add(listener);
            const unsubscribe = () => void changed.delete(listener);
            onDispose(unsubscribe);
            return unsubscribe;
        },
        use: () => evi.module.React.useSyncExternalStore(listener => {
            changed.add(listener);
            return () => void changed.delete(listener);
        }, snapshot),
    };

    const notFaked = (member: string) => () => {
        throw new Error(`fakeContext doesn't fake ctx.${member}: pass it in fakeContext({ overrides: { ${member.split(".")[0]}: ... } })`);
    };
    const ctx = {
        id,
        manifest: { id, name: id },
        logger,
        settings,
        onDispose,
        waitFor: (filter: Filter, callback: (value: any, found: FoundExport) => void) => {
            let active = true;
            const unsubscribe = evi.module.waitFor(filter, (value, found) => {
                if (active) callback(value, found);
            });
            return onDispose(() => {
                active = false;
                unsubscribe();
            });
        },
        flux: {
            subscribe(type: string, handler: (action: FluxAction) => void) {
                const safe = (action: FluxAction) => {
                    try {
                        handler(action);
                    } catch (err) {
                        logs.push({ level: "error", args: [`Flux handler for ${type} threw`, err] });
                    }
                };
                evi.module.Dispatcher.subscribe(type, safe);
                return onDispose(() => evi.module.Dispatcher.unsubscribe(type, safe));
            },
            dispatch: (action: FluxAction) => evi.module.Dispatcher.dispatch(action),
        },
        native: {
            call(method: string, ...args: unknown[]) {
                if (!native) throw new Error(`${id} has no native module`);
                return native(method, ...args);
            },
        },
        addStyle(css: string) {
            const style = { css };
            styles.push(style);
            const remove = () => {
                const at = styles.indexOf(style);
                if (at >= 0) styles.splice(at, 1);
            };
            onDispose(remove);
            return { update: (next: string) => void (style.css = next), remove };
        },
        toast: (message: unknown) => void toasts.push(message),
        setInterval(fn: () => void, ms: number) {
            const handle = setInterval(fn, ms);
            return onDispose(() => clearInterval(handle));
        },
        setTimeout(fn: () => void, ms: number) {
            const handle = setTimeout(fn, ms);
            return onDispose(() => clearTimeout(handle));
        },
        hook: { before: notFaked("hook.before"), after: notFaked("hook.after"), instead: notFaked("hook.instead") },
        hookExport: notFaked("hookExport"),
        contextMenu: notFaked("contextMenu"),
        command: notFaked("command"),
        panelToggle: notFaked("panelToggle"),
        profileBadges: notFaked("profileBadges"),
        keybind: notFaked("keybind"),
        ...overrides,
    };

    return {
        // A plain object: Evi's PluginContext is a class with private fields, which no other object's type matches
        ctx: ctx as unknown as PluginContext<S>,
        logs,
        get styles() { return styles.map(s => s.css); },
        toasts,
        evi,
        dispose() {
            disposed = true;
            for (const fn of disposers.splice(0).reverse()) run(fn);
        },
        get disposed() { return disposed; },
    };
}
