/** mist dev: each hot reload of a plugin and how it went, heard through Evi.plugins.subscribe */
import { CdpError, evaluate, type Send } from "./cdp.ts";
import { pageExpression } from "./page.ts";

export interface DevState { version: string; running: boolean; error: string | null; needsReload: boolean; reloadReason: string | null; }
/** A change the page heard; `reloaded` when the plugin's manifest was replaced and no other plugin's was */
export interface DevRecord extends DevState { at: number; reloaded: boolean; removed: boolean; }
export interface DevStart { source: string; state: DevState; }

/**
 * Page side. A hot reload gives the plugin a new manifest object (manager.ts setManifest), and so
 * does a change of Discord's language, but that replaces every plugin's at once.
 */
function start(id: string, ttlMs: number): (DevStart & { key: string; }) | { error: string; } {
    const P = (globalThis as any).Evi?.plugins;
    if (!P?.subscribe) return { error: "This Evi has no Evi.plugins.subscribe" };
    const watches: Map<string, any> = (globalThis as any)[Symbol.for("mist-cli.dev")] ??= new Map();
    const read = () => {
        const s = P.get(id);
        return s && { manifest: s.manifest, source: s.source, state: { version: s.manifest.version ?? "", running: s.running, error: s.error ?? null, needsReload: !!s.needsReload, reloadReason: s.reloadReason ?? null } };
    };
    const others = () => new Set(P.getSnapshot().filter((s: any) => s.manifest.id !== id).map((s: any) => s.manifest));
    let last = read();
    if (!last) return { error: `${id} isn't installed (mist status lists mist plugins, Evi.plugins.getSnapshot() all of them)` };
    let lastOthers = others();
    const watch = { buffer: [] as DevRecord[], last: Date.now(), stop: () => { } };
    const unsubscribe = P.subscribe(() => {
        try {
            const now = read();
            const nowOthers = others();
            if (!now) {
                watch.buffer.push({ ...last.state, at: Date.now(), reloaded: false, removed: true });
                return;
            }
            const relocalized = [...lastOthers].some(m => !nowOthers.has(m)) && nowOthers.size >= lastOthers.size;
            const reloaded = now.manifest !== last.manifest && !relocalized;
            if (reloaded || JSON.stringify(now.state) !== JSON.stringify(last.state)) watch.buffer.push({ ...now.state, at: Date.now(), reloaded, removed: false });
            last = now;
            lastOthers = nowOthers;
        } catch { }
    });
    const watchdog = setInterval(() => { if (Date.now() - watch.last > ttlMs) watch.stop(); }, Math.max(10, ttlMs / 4));
    const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    watch.stop = () => {
        clearInterval(watchdog);
        unsubscribe();
        watches.delete(key);
    };
    watches.set(key, watch);
    return { source: last.source, state: last.state, key };
}

function take(key: string): { records: DevRecord[]; alive: boolean; } {
    const watch = (globalThis as any)[Symbol.for("mist-cli.dev")]?.get(key);
    if (!watch) return { records: [], alive: false };
    watch.last = Date.now();
    return { records: watch.buffer.splice(0), alive: true };
}

function stop(key: string) {
    const watches = (globalThis as any)[Symbol.for("mist-cli.dev")];
    watches?.get(key)?.stop();
    return watches?.size ?? 0;
}

export interface PatchHealth { health: Record<string, number>; problems: { index: number; health: string; find: string; errors: string[]; }[]; }

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
    const { pollMs = 250, ttlMs = 15_000, settleMs = 1000, stopped = () => false } = options;
    const started = await evaluate<(DevStart & { key: string; }) | { error: string; }>(send, pageExpression(start, [id, ttlMs]));
    if ("error" in started) throw new CdpError(started.error);
    options.onStart?.(started);
    let pending: DevRecord[] = [];
    let quietSince = 0;
    const settle = async () => {
        const reload = pending.find(r => r.reloaded);
        const latest = pending[pending.length - 1];
        const { at: _at, reloaded: _r, removed, ...state } = latest;
        pending = [];
        onOutcome({ at: (reload ?? latest).at, reloaded: !!reload, removed, state, patches: reload && !removed ? await options.patches() : null });
    };
    try {
        while (!stopped()) {
            await new Promise(resolve => setTimeout(resolve, pollMs));
            const { records, alive } = await evaluate<{ records: DevRecord[]; alive: boolean; }>(send, pageExpression(take, [started.key]));
            if (records.length) {
                pending.push(...records);
                quietSince = Date.now();
            } else if (pending.length && Date.now() - quietSince >= settleMs) await settle();
            if (!alive) throw new CdpError("The page ended the watch: it reloaded, or the CLI didn't read it for 15 seconds");
        }
        if (pending.length) await settle();
    } finally {
        await evaluate(send, pageExpression(stop, [started.key])).catch(() => { });
    }
}

export function devLines(o: DevOutcome, time: (at: number) => string): string[] {
    const s = o.state;
    const what = o.removed ? "removed" : o.reloaded ? `reloaded ${s.version}` : "changed";
    const how = o.removed ? "" : s.error ? `, start error: ${s.error}` : s.running ? ", running" : ", not running";
    const out = [`${time(o.at)} ${what}${how}`];
    if (s.needsReload) out.push(`  needs a Discord reload (Ctrl+R): ${s.reloadReason ?? "a patch can't apply live"}`);
    if (o.patches) {
        const counts = Object.entries(o.patches.health).map(([k, v]) => `${v} ${k}`).join(", ") || "none";
        out.push(`  patches: ${counts}`, ...o.patches.problems.map(p => `    #${p.index} ${p.health} find ${p.find}${p.errors.length ? `: ${p.errors.join("; ")}` : ""}`));
    }
    return out;
}
