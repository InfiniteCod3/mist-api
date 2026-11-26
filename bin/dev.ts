/** mist dev: each hot reload of a plugin and how it went, heard through Evi.plugins.subscribe */
import { CliError, type Send, sleep, watchId } from "./cdp.ts";
import { type PatchHealth, patchHealthLines, watchEndedMessage } from "./format.ts";
import { type PageError, type PageGlobal, pageCall, WATCH_TTL_MS } from "./page.ts";

export interface DevState { version: string; running: boolean; error: string | null; needsReload: boolean; reloadReason: string | null; }
/** A change the page heard; `reloaded` when the plugin's manifest was replaced and no other plugin's was */
export interface DevRecord extends DevState { at: number; reloaded: boolean; removed: boolean; }
export interface DevStart { source: string; state: DevState; }

interface PluginSnapshot {
    manifest: { id: string; version?: string; };
    source: string;
    running: boolean;
    error?: string;
    needsReload?: boolean;
    reloadReason?: string;
}
interface EviPlugins { get(id: string): PluginSnapshot | undefined; getSnapshot(): PluginSnapshot[]; subscribe(fn: () => void): () => void; }
interface DevWatch { buffer: DevRecord[]; last: number; stop(): void; }
type DevPage = PageGlobal<{ Evi?: { plugins?: EviPlugins; }; [watches: symbol]: Map<string, DevWatch> | undefined; }>;

/**
 * Page side. A hot reload gives the plugin a new manifest object (manager.ts setManifest). A change
 * of Discord's language does too, but replaces every plugin's at once.
 */
function start(id: string, key: string, ttlMs: number): DevStart | PageError {
    const page = globalThis as DevPage;
    const plugins = page.Evi?.plugins;
    if (!plugins?.subscribe) return { error: "This Evi has no Evi.plugins.subscribe" };
    const watches = page[Symbol.for("mist-cli.dev")] ??= new Map<string, DevWatch>();
    const read = () => {
        const snapshot = plugins.get(id);
        if (!snapshot) return undefined;
        const state: DevState = {
            version: snapshot.manifest.version ?? "",
            running: snapshot.running,
            error: snapshot.error ?? null,
            needsReload: !!snapshot.needsReload,
            reloadReason: snapshot.reloadReason ?? null,
        };
        return { manifest: snapshot.manifest, source: snapshot.source, state };
    };
    const others = () => new Set(plugins.getSnapshot().filter(snapshot => snapshot.manifest.id !== id).map(snapshot => snapshot.manifest));
    const first = read();
    if (!first) return { error: `${id} isn't installed (mist status lists mist plugins, Evi.plugins.getSnapshot() all of them)` };
    let last: typeof first | undefined = first;
    let lastOthers = others();
    const watch: DevWatch = { buffer: [], last: Date.now(), stop: () => { } };
    const unsubscribe = plugins.subscribe(() => {
        try {
            const now = read();
            const nowOthers = others();
            const relocalized = [...lastOthers].some(manifest => !nowOthers.has(manifest)) && nowOthers.size >= lastOthers.size;
            lastOthers = nowOthers;
            if (!now) {
                if (last) watch.buffer.push({ ...last.state, at: Date.now(), reloaded: false, removed: true });
                last = undefined;
                return;
            }
            const reloaded = !last || (now.manifest !== last.manifest && !relocalized);
            if (reloaded || JSON.stringify(now.state) !== JSON.stringify(last?.state)) watch.buffer.push({ ...now.state, at: Date.now(), reloaded, removed: false });
            last = now;
        } catch { }
    });
    const watchdog = setInterval(() => { if (Date.now() - watch.last > ttlMs) watch.stop(); }, Math.max(10, ttlMs / 4));
    watch.stop = () => {
        clearInterval(watchdog);
        unsubscribe();
        watches.delete(key);
    };
    watches.set(key, watch);
    return { source: first.source, state: first.state };
}

function take(key: string): { records: DevRecord[]; alive: boolean; } {
    const watch = (globalThis as DevPage)[Symbol.for("mist-cli.dev")]?.get(key);
    if (!watch) return { records: [], alive: false };
    watch.last = Date.now();
    return { records: watch.buffer.splice(0), alive: true };
}

function stop(key: string): number {
    const watches = (globalThis as DevPage)[Symbol.for("mist-cli.dev")];
    watches?.get(key)?.stop();
    return watches?.size ?? 0;
}

/** What one reload, or one change between reloads, came to once the plugin settled */
export interface DevOutcome { at: number; reloaded: boolean; removed: boolean; state: DevState; patches: PatchHealth | null; }

export interface DevOptions {
    pollMs?: number;
    ttlMs?: number;
    /** Quiet time after a change before it counts as settled: an async start ends later than the reload */
    settleMs?: number;
    stopped?: () => boolean;
    /** The plugin's patch health, read after each reload */
    patches: () => Promise<PatchHealth | null>;
    onStart?: (start: DevStart) => void;
}

export async function watchDev(send: Send, id: string, options: DevOptions, onOutcome: (outcome: DevOutcome) => void): Promise<void> {
    const { pollMs = 250, ttlMs = WATCH_TTL_MS, settleMs = 1000, stopped = () => false } = options;
    const key = watchId();
    const started = await pageCall(send, start, [id, key, ttlMs]);
    options.onStart?.(started);
    let pending: DevRecord[] = [];
    let quietSince = 0;
    const settle = async () => {
        const reload = pending.find(record => record.reloaded);
        const latest = pending[pending.length - 1];
        const { at: _at, reloaded: _reloaded, removed, ...state } = latest;
        pending = [];
        onOutcome({ at: (reload ?? latest).at, reloaded: !!reload, removed, state, patches: reload && !removed ? await options.patches() : null });
    };
    try {
        while (!stopped()) {
            await sleep(pollMs);
            const { records, alive } = await pageCall(send, take, [key]);
            if (records.length) {
                pending.push(...records);
                quietSince = Date.now();
            } else if (pending.length && Date.now() - quietSince >= settleMs) await settle();
            if (!alive) throw new CliError(watchEndedMessage(ttlMs));
        }
        if (pending.length) await settle();
    } finally {
        await pageCall(send, stop, [key]).catch(() => { });
    }
}

/** What happened, as in "reloaded 1.2.0, running" */
function devSummary({ removed, reloaded, state }: DevOutcome): string {
    if (removed) return "removed";
    const what = reloaded ? `reloaded ${state.version}` : "changed";
    if (state.error) return `${what}, start error: ${state.error}`;
    return `${what}, ${state.running ? "running" : "not running"}`;
}

export function devLines(outcome: DevOutcome, time: (at: number) => string): string[] {
    const out = [`${time(outcome.at)} ${devSummary(outcome)}`];
    if (outcome.state.needsReload) out.push(`  needs a Discord reload (Ctrl+R): ${outcome.state.reloadReason ?? "a patch can't apply live"}`);
    if (outcome.patches) out.push(...patchHealthLines(outcome.patches));
    return out;
}
