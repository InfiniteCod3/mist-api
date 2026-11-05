/** mist perf: Evi's per-plugin time (Evi.perf.snapshot()), and patches that applied but never called into their plugin */
import { evaluate, type Send } from "./cdp.ts";
import { pageExpression } from "./page.ts";

interface Totals { calls: number; ms: number; max: number; }
export interface SiteReport extends Totals { kind: string; name: string; recent: Totals; }
export interface PluginReport extends Totals { plugin: string; recent: Totals; sites: SiteReport[]; }
/** An applied patch whose string replacements name $self functions, none of which has run */
export interface Unrun { plugin: string; index: number; find: string; names: string[]; modules: string[]; }
export interface PerfReport {
    plugins: PluginReport[];
    /** Evi.stats: what Evi added to module loading */
    stats: Record<string, number> | null;
    unrun: Unrun[];
    /** Patches with function replacements, whose $self names can't be read */
    unreadable: number;
}

/** Page side. Reads only: Evi.perf.record would restart a recording the Performance tab may be making. */
function perfPage(): PerfReport {
    const SELF = /\$self(?:\?\.|\.)([A-Za-z_$][\w$]*)/g;
    const E = (globalThis as any).Evi;
    const plugins: PluginReport[] = E.perf.snapshot();
    const called = new Map<string, number>();
    for (const p of plugins) for (const s of p.sites) if (s.kind === "patch") called.set(`${p.plugin}\0${s.name}`, s.calls);
    const unrun: Unrun[] = [];
    let unreadable = 0;
    for (const p of E.diagnosePatches()) {
        if (p.state !== "applied" && p.state !== "partial") continue;
        const names = new Set<string>();
        for (const r of [p.patch.replace].flat()) {
            if (typeof r.with === "string") for (const [, name] of r.with.matchAll(SELF)) names.add(name);
            else unreadable++;
        }
        if (names.size && [...names].every(name => !called.get(`${p.plugin}\0$self.${name}`))) {
            unrun.push({ plugin: p.plugin, index: p.index, find: String(p.patch.find), names: [...names], modules: p.modules });
        }
    }
    return { plugins, stats: E.stats && typeof E.stats === "object" ? { ...E.stats } : null, unrun, unreadable };
}

export const readPerf = (send: Send) => evaluate<PerfReport>(send, pageExpression(perfPage, []));

const ms = (n: number) => n >= 100 ? `${Math.round(n)} ms` : `${n.toFixed(1)} ms`;

export function perfLines({ plugins, stats, unrun, unreadable }: PerfReport, sites: number): string[] {
    const out: string[] = [];
    if (stats) out.push(`Evi on module loading: ${stats.modules} modules, ${stats.patchedModules} patched, patching ${ms(stats.patchMs)}, listeners ${ms(stats.listenerMs)}`);
    out.push(plugins.length ? `${plugins.length} plugins ran code, by time in the last 10 seconds, then since start` : "No plugin has run code that Evi measures.");
    for (const p of plugins) {
        out.push(`  ${p.plugin}  ${ms(p.ms)} in ${p.calls} calls, slowest ${ms(p.max)}  last 10 s: ${ms(p.recent.ms)} in ${p.recent.calls}`);
        for (const s of p.sites.slice(0, sites)) out.push(`    ${s.kind.padEnd(7)} ${s.name}  ${ms(s.ms)} in ${s.calls}, slowest ${ms(s.max)}`);
        if (p.sites.length > sites) out.push(`    … ${p.sites.length - sites} more sites (--all shows each)`);
    }
    out.push(unrun.length ? `${unrun.length} applied patches whose $self functions haven't run: their code may wait on a screen not opened yet, or never runs` : "Every applied patch that names $self functions has called one.");
    for (const u of unrun) out.push(`  ${u.plugin} #${u.index} find ${u.find.length > 80 ? `${u.find.slice(0, 80)}…` : u.find}  modules ${u.modules.join(",") || "none"}  never called: ${u.names.map(n => `$self.${n}`).join(", ")}`);
    if (unreadable) out.push(`${unreadable} replacements are functions, so their $self names can't be read`);
    return out;
}
