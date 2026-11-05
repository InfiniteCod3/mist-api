/**
 * What the UI registries share: who owns an entry, how errors are logged once, and the per-page state
 * on globalThis. Patched Discord code reads that state by its Symbol.for key, so the key is the
 * protocol between copies and the patches: change its version when the state's shape changes.
 */
import { need, pluginOf } from "../permissions.ts";
import { errorMessage } from "../protocol.ts";

/** What mist.log and Evi's ctx.logger both have */
export interface ErrorLog {
    error(...args: unknown[]): void;
}

/** A plugin's mist (createMist's result) */
export interface MistOwner {
    readonly id: string;
    /** Throws while the plugin isn't running, so adding UI to a stopped plugin fails loudly */
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
 * The owner of a registry entry: the plugin's own mist object, checked against mist's page registry
 * (pluginOf). With `reads`, the entry hands the plugin message content, so its manifest must declare
 * readMessages, or nothing, as Evi's guard asks of a hook on sending and editing.
 */
export function entryOwner(mist: MistOwner, usage: string, reads: boolean): Owned {
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

const SEEN_MAX = 50;
const seen = new WeakMap<ErrorLog, Set<string>>();

/** Logs `line` with `err`, once per log for each of the first 50 distinct line and message pairs */
export function logOnce(log: ErrorLog, line: string, err: unknown) {
    let lines = seen.get(log);
    if (!lines) seen.set(log, lines = new Set());
    const key = `${line}\n${errorMessage(err)}`;
    if (lines.has(key) || lines.size >= SEEN_MAX) return;
    lines.add(key);
    log.error(line, err);
}

export const UI_PROTOCOL = 1;

/** The key patched code reads: `mist-api.ui/<name>@<protocol>` */
export const uiKey = (name: string) => `mist-api.ui/${name}@${UI_PROTOCOL}`;

/** The expression patched Discord code uses to reach the state under `uiKey(name)` */
export const uiRef = (name: string) => `globalThis[Symbol.for(${JSON.stringify(uiKey(name))})]`;

/**
 * The page's state under `uiKey(name)`, made by the first copy that asks. The first copy's functions
 * serve every copy until Discord reloads, so they only read the state, never the copy's own variables.
 */
export function shared<T extends { readonly protocol: number; }>(name: string, make: () => T, valid: (state: T) => boolean): T {
    const key = Symbol.for(uiKey(name));
    const target = globalThis as unknown as Record<symbol, T | undefined>;
    const existing = target[key];
    if (existing) {
        if (existing.protocol !== UI_PROTOCOL || !valid(existing)) throw new Error(`mist ui: ${uiKey(name)} was made by an incompatible copy`);
        return existing;
    }
    const created = make();
    Object.defineProperty(target, key, { value: created, configurable: false, enumerable: false, writable: false });
    return created;
}

/** Calls each listener; one throwing doesn't stop the others */
export function notify(listeners: Set<() => void>) {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch (err) {
            console.error("mist ui: a listener threw", err);
        }
    }
}

/**
 * A source patch replacement that inserts code containing `marker` once per module, however many
 * plugins carry the patch. A later copy finds the marker and adds only a comment: Evi counts a
 * replacement that changes nothing as failed, and the plugin that inserted the code may be the one
 * turned off next, when Evi runs the module again without it.
 */
export function insertOnce(marker: string, code: (match: string, groups: string[]) => string) {
    return (match: string, ...rest: unknown[]) => {
        // No named groups in these patches, so the module's code is the last argument
        const module = rest[rest.length - 1] as string;
        if (module.includes(marker)) return `${match}/*${marker}*/`;
        return code(match, rest.slice(0, -2) as string[]);
    };
}
