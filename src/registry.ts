/**
 * The page-wide debug registry behind `window.Mist`. The first copy of mist-api installs it and later
 * copies join; each handle carries its own methods, so copies of different versions work together.
 */
import { patchHealth } from "./patches.ts";
import type { CallRecord, LogRecord, ReducedNativeLogs } from "./protocol.ts";
import type { Reduced } from "./values.ts";

// A protocol name, not the package name: copies published under another name must still meet here
const REGISTRY = Symbol.for("mist-api.registry.v1");

/** What the plugin's native side turned out to be */
export type NativeKind = "unknown" | "none" | "plain" | "mist";

export interface HandleState {
    id: string;
    mistVersion: string;
    running: boolean;
    /** Date.now() of the current run's start */
    startedAt: number | null;
    native: NativeKind;
    /** Whether `mist call` and full native values work: main was started with a debugging port */
    debug: boolean;
    /** Failed native calls and error log lines on the page side, among those still kept */
    errors: { calls: number; logs: number; };
    /** Calls of each quiet method on the page side, which aren't kept */
    quiet?: Record<string, number>;
    /** The bus protocols the plugin says it provides, and their versions. Absent from older copies. */
    provides?: Record<string, number>;
    /**
     * What the plugin got wrong in this run: a store read in start before Discord made it, a plugin it
     * needs at another protocol version, a settings migration that threw. Absent from older copies.
     */
    warnings?: string[];
}

/** A plugin's entry in the registry. Values are reduced to type and size; nothing here can call the plugin. */
export interface MistHandle {
    readonly id: string;
    readonly mistVersion: string;
    /** The bus protocols the plugin provides and their versions. Copies of 0.2.1 and earlier have none. */
    readonly provides?: Readonly<Record<string, number>>;
    state(): HandleState;
    logs(n?: number): LogRecord<Reduced>[];
    calls(n?: number): CallRecord<Reduced>[];
    /** null when the plugin has no mist native side, or isn't running */
    nativeLogs(n?: number): Promise<ReducedNativeLogs | null>;
    values(): Record<string, Reduced>;
    /** null while the plugin isn't running */
    settings(): Record<string, Reduced> | null;
    /** Always refuses: calls go through the capability, which a debugger reads from the handle's private field */
    call(method: string, ...args: unknown[]): Promise<never>;
}

/** How a plugin id's handle changed hands in this page's registry */
export interface RegistryHistory {
    /** Registrations that went in, the first one included */
    registered: number;
    /** Registrations that took the place of another handle */
    replaced: number;
    /** Registrations refused because the id's handle said its plugin was running */
    refused: number;
    /** Registrations by a handle that another one had taken the place of */
    reclaimed: number;
}

export interface Registry {
    readonly version: 1;
    /**
     * Puts the handle in for its id, in place of a handle whose plugin isn't running (a hot reload
     * stops the old run first). While the id's handle says its plugin runs, the registration is
     * refused and counted. Returns the unregister function, which does nothing for a refused one.
     */
    register(handle: MistHandle): () => void;
    get(id: string): MistHandle | undefined;
    list(): MistHandle[];
    /** Absent from a registry that keeps no history */
    history?(id: string): RegistryHistory | undefined;
    /** Why the CLI shouldn't trust the id's handle, empty when nothing is wrong. Absent from a registry that keeps no history. */
    concerns?(id: string): string[];
}

interface PatchDiagnosis { plugin: string; index: number; health: string; errors?: string[]; patch?: { find?: unknown; }; }
interface LookupDiagnosis { plugin: string; target: string; health: string; }
/** What mist reads of `window.Evi`. Every member is optional: page code can replace `Evi.plugins`, and older Evis lack some. */
export interface EviDebug {
    version?: string;
    diagnosePatches?(): PatchDiagnosis[];
    diagnoseLookups?(plugin?: string): LookupDiagnosis[];
    plugins?: {
        get(id: string): { running?: boolean; error?: string; evaluated?: boolean; manifest?: { name?: string; version?: string; }; } | undefined;
        subscribe?(listener: () => void): () => void;
    };
}

export const eviOf = (root: object = globalThis) => (root as { Evi?: EviDebug; }).Evi;

const PATCH_PROBLEMS = new Set(["failed", "partial", "broken", "ambiguous"]);
const LOOKUP_PROBLEMS = new Set(["broken", "missing"]);

function countBy<T>(items: T[], key: (item: T) => string) {
    const counts: Record<string, number> = {};
    for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
    return counts;
}

type Attempt<T> = { ok: true; value: T; } | { ok: false; error: string; };
function attempt<T>(fn: () => T): Attempt<T> {
    try { return { ok: true, value: fn() }; } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
}
const unwrap = <T, R>(result: Attempt<T>, show: (value: T) => R) => result.ok ? show(result.value) : { error: result.error };

const reportsRunning = (handle: MistHandle) => attempt(() => handle.state().running === true);

/**
 * What the registry's records and Evi say against trusting a handle. Evi's word is a check, not
 * proof: page code can wrap Evi.plugins.get as it can anything else.
 */
export function concerns(id: string, handle: MistHandle, history: RegistryHistory, evi: EviDebug | undefined): string[] {
    const out: string[] = [];
    if (history.refused) out.push(`${history.refused} registration${history.refused === 1 ? " was" : "s were"} refused while ${id}'s handle said it was running: two handles claim this id`);
    if (history.reclaimed) out.push(`${id}'s handle was replaced while the plugin was stopped, and the plugin took it back at its next start`);
    const says = reportsRunning(handle);
    const evis = evi?.plugins ? attempt(() => evi.plugins!.get(id)?.running) : null;
    if (says.ok && says.value && evis?.ok && evis.value === false) out.push(`${id}'s handle says the plugin runs, but Evi says it is stopped`);
    return out;
}

/** Each registered plugin's state, with its patch and lookup health from Evi's own diagnostics */
export function status(handles: MistHandle[], evi: EviDebug | undefined, registry?: Registry) {
    // One scan of every module for all plugins: diagnosePatches has no per-plugin form
    const patches = evi?.diagnosePatches ? attempt(() => evi.diagnosePatches!()) : null;
    return handles.map(handle => {
        const id = handle.id;
        const lookups = evi?.diagnoseLookups ? attempt(() => evi.diagnoseLookups!(id)) : null;
        const evis = evi?.plugins ? attempt(() => evi.plugins!.get(id)) : null;
        return {
            id,
            mistVersion: handle.mistVersion,
            state: unwrap(attempt(() => handle.state()), s => s),
            startError: evis?.ok ? evis.value?.error ?? null : null,
            registry: registry?.history?.(id) ?? null,
            concerns: registry?.concerns?.(id) ?? null,
            patches: patches && unwrap(patches, all => {
                const mine = all.filter(p => p.plugin === id).map(p => ({ ...p, health: patchHealth(p.health, p.patch) }));
                return {
                    total: mine.length,
                    health: countBy(mine, p => p.health),
                    problems: mine.filter(p => PATCH_PROBLEMS.has(p.health)).map(p => ({ index: p.index, health: p.health, find: String(p.patch?.find), errors: p.errors ?? [] })),
                };
            }),
            lookups: lookups && unwrap(lookups, ours => ({
                total: ours.length,
                health: countBy(ours, l => l.health),
                problems: ours.filter(l => LOOKUP_PROBLEMS.has(l.health)).map(l => ({ target: l.target, health: l.health })),
            })),
        };
    });
}

interface Entry {
    handle: MistHandle | undefined;
    history: RegistryHistory;
    /** Handles another one took the place of: one coming back means something swapped it out */
    displaced: WeakSet<MistHandle>;
}

function createRegistry(root: object): Registry {
    const entries = new Map<string, Entry>();
    const evi = () => eviOf(root);
    return Object.freeze({
        version: 1 as const,
        register(handle: MistHandle) {
            const id = handle.id;
            let entry = entries.get(id);
            if (!entry) entries.set(id, entry = { handle: undefined, history: { registered: 0, replaced: 0, refused: 0, reclaimed: 0 }, displaced: new WeakSet() });
            const unregister = () => { if (entry.handle === handle) entry.handle = undefined; };
            const current = entry.handle;
            if (current === handle) return unregister;
            if (current) {
                const running = reportsRunning(current);
                if (running.ok && running.value) {
                    entry.history.refused++;
                    return () => { };
                }
                entry.displaced.add(current);
                entry.history.replaced++;
            }
            if (entry.displaced.has(handle)) entry.history.reclaimed++;
            entry.handle = handle;
            entry.history.registered++;
            return unregister;
        },
        get: (id: string) => entries.get(id)?.handle,
        list: () => [...entries.values()].flatMap(e => e.handle ? [e.handle] : []),
        history: (id: string) => {
            const entry = entries.get(id);
            return entry && { ...entry.history };
        },
        concerns: (id: string) => {
            const entry = entries.get(id);
            return entry?.handle ? concerns(id, entry.handle, entry.history, evi()) : [];
        },
    }) satisfies Registry;
}

const usable = (value: unknown): value is Registry =>
    typeof value === "object" && value !== null && (value as Registry).version === 1 && typeof (value as Registry).register === "function";

/** The page's registry, installed with `window.Mist` by the first copy to ask */
export function registry(root: object = globalThis): Registry {
    const target = root as Record<symbol, unknown>;
    const existing = target[REGISTRY];
    if (usable(existing)) return existing;
    // Something else took the key: this copy keeps its own registry rather than break the plugin
    if (existing !== undefined) return createRegistry(root);

    const created = createRegistry(root);
    Object.defineProperty(target, REGISTRY, { value: created, configurable: false, enumerable: false, writable: false });
    const api = Object.freeze({
        version: 1 as const,
        list: () => created.list().map(h => ({ id: h.id, mistVersion: h.mistVersion, running: unwrap(attempt(() => h.state().running), r => r) })),
        get: (id: string) => created.get(id),
        status: () => status(created.list(), eviOf(root), created),
    });
    // Not configurable, so page code can't put a lying status in its place. Something that took the name first keeps it.
    try {
        Object.defineProperty(root, "Mist", { get: () => api, configurable: false, enumerable: false });
    } catch { }
    return created;
}

