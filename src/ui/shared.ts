/**
 * What the UI registries share: who owns an entry, how errors are logged once, and the per-page state
 * on globalThis. Patched Discord code reads that state by its Symbol.for key. The key is the protocol
 * between copies and the patches: change its version when the state's shape changes.
 */
import { createLogOnce, globalSlot, type LogOnce, notifyEach } from "../internal.ts";
import { need, pluginOf } from "../permissions.ts";

/** What mist.log and Evi's ctx.logger both have */
export interface ErrorLog {
    error(...args: unknown[]): void;
}

/** A plugin's mist (createMist's result) */
export interface MistOwner {
    readonly id: string;
    /** Throws while the plugin isn't running: adding UI to a stopped plugin fails loudly */
    readonly ctx: { onDispose(fn: () => void): unknown; };
    readonly log: ErrorLog;
}

/** A plugin's context, for a host of a plugin that doesn't use mist.define */
export interface ContextOwner {
    readonly id: string;
    onDispose(fn: () => void): unknown;
    readonly logger: ErrorLog;
}

/** The plugin that sets a host: it's cleared when the plugin stops, and its errors go to the plugin's log */
export type Owner = MistOwner | ContextOwner;

export interface Owned {
    readonly id: string;
    readonly log: ErrorLog;
    onDispose(fn: () => void): void;
}

/**
 * The owner of a registry entry: the mist object createMist gave the plugin, checked against mist's
 * page registry (pluginOf). With `reads`, the entry hands the plugin message content. Its manifest
 * must then declare readMessages, or nothing, as Evi's guard asks of a hook on sending and editing.
 */
export function entryOwner(mist: MistOwner, usage: string, { reads = false }: { reads?: boolean; } = {}): Owned {
    const id = pluginOf(mist, usage);
    if (reads) need(id, "readMessages", usage);
    return owned(mist);
}

export function owned(owner: Owner): Owned {
    if ("ctx" in owner) {
        const ctx = owner.ctx;
        return { id: owner.id, log: owner.log, onDispose: fn => void ctx.onDispose(fn) };
    }
    return { id: owner.id, log: owner.logger, onDispose: fn => void owner.onDispose(fn) };
}

const loggers = new WeakMap<ErrorLog, LogOnce>();

/**
 * Logs `line`, with `err` when given, once per log for each of the first 50 distinct line and message
 * pairs. The first pair past that logs one notice instead: a quiet log mustn't read as a healthy plugin.
 */
export function logOnce(log: ErrorLog, line: string, ...err: [err?: unknown]) {
    let write = loggers.get(log);
    if (!write) loggers.set(log, write = createLogOnce((...args) => log.error(...args), "mist-api/ui"));
    write(line, ...err);
}

/** Sorts entries by their `<plugin id>/<id>` key: the order doesn't depend on which plugin started first */
export function byKey(a: { readonly key: string; }, b: { readonly key: string; }): number {
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return 0;
}

/**
 * Numbers objects in the order first asked about. Made inside a state's `make`: every copy of
 * mist-api numbers through the first copy's function, and two copies never hand out the same number.
 */
export function instanceIds(): (instance: object) => number {
    const ids = new WeakMap<object, number>();
    let last = 0;
    return instance => {
        let id = ids.get(instance);
        if (id === undefined) ids.set(instance, id = ++last);
        return id;
    };
}

const UI_PROTOCOL = 1;

/** The key patched code reads: `mist-api.ui/<name>@<protocol>` */
const uiKey = (name: string) => `mist-api.ui/${name}@${UI_PROTOCOL}`;

/** The expression patched Discord code uses to reach the state under `uiKey(name)` */
export const uiRef = (name: string) => `globalThis[Symbol.for(${JSON.stringify(uiKey(name))})]`;

/**
 * The page's state under `uiKey(name)`, made by the first copy that asks. The first copy's functions
 * serve every copy until Discord reloads. They read only the state, never variables of the copy that
 * made them. The key carries the version, and `valid` checks only the shape. Each state still sets
 * `protocol: 1`, because mist-api 0.4.0 refuses a state without it.
 */
export function uiState<T extends object>(name: string, make: () => T, valid: (state: T) => boolean): T {
    const key = uiKey(name);
    const isState = (value: unknown): value is T => typeof value === "object" && value !== null && valid(value as T);
    return globalSlot(Symbol.for(key), make, isState, `The UI state ${key}`);
}

/** Calls each listener. One that throws is logged under `fn` and doesn't keep the others from hearing. */
export function notify(fn: string, listeners: Set<() => void>) {
    notifyEach(listeners, [], (_, err) => console.error(`${fn}: a listener threw`, err));
}

/**
 * A source patch replacement that inserts code containing `marker` once per module, however many
 * plugins carry the patch. A later copy finds the marker and adds only a comment: Evi counts a
 * replacement that changes nothing as failed, and the plugin that inserted the code may be the one
 * turned off next, when Evi runs the module again without it.
 */
export function insertOnce(marker: string, code: (match: string, groups: string[]) => string) {
    return (match: string, ...rest: unknown[]) => {
        // No named groups in these patches: the module's code is the last argument
        const module = rest[rest.length - 1] as string;
        if (module.includes(marker)) return `${match}/*${marker}*/`;
        return code(match, rest.slice(0, -2) as string[]);
    };
}
