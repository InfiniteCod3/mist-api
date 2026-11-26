/** mist perf: Evi's per-plugin time (Evi.perf.snapshot()), and patches that applied but never called into their plugin */
import type { Send } from "./cdp.ts";
import { clip } from "./format.ts";
import { type PageGlobal, pageCall } from "./page.ts";

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

interface Diagnosis {
    plugin: string;
    index: number;
    /** Whether Evi applied it; `health` can't say, as "ambiguous" covers both applied and waiting patches */
    state: "pending" | "applied" | "partial" | "failed";
    modules: string[];
    patch: { find: unknown; replace: { with: unknown; } | { with: unknown; }[]; };
}
type PerfPage = PageGlobal<{ Evi: { perf: { snapshot(): PluginReport[]; }; diagnosePatches(): Diagnosis[]; stats?: Record<string, number>; }; }>;

/** Page side. Reads only: Evi.perf.record would restart a recording the Performance tab may be making. */
function perfPage(): PerfReport {
    const SELF = /\$self(?:\?\.|\.)([A-Za-z_$][\w$]*)/g;
    const evi = (globalThis as PerfPage).Evi;
    const plugins = evi.perf.snapshot();
    const called = new Map<string, number>();
    for (const plugin of plugins) {
        for (const site of plugin.sites) if (site.kind === "patch") called.set(`${plugin.plugin}\0${site.name}`, site.calls);
    }
    const unrun: Unrun[] = [];
    let unreadable = 0;
    for (const diagnosis of evi.diagnosePatches()) {
        if (diagnosis.state !== "applied" && diagnosis.state !== "partial") continue;
        const names = new Set<string>();
        for (const replacement of [diagnosis.patch.replace].flat()) {
            if (typeof replacement.with === "string") for (const [, name] of replacement.with.matchAll(SELF)) names.add(name);
            else unreadable++;
        }
        if (names.size && [...names].every(name => !called.get(`${diagnosis.plugin}\0$self.${name}`))) {
            unrun.push({ plugin: diagnosis.plugin, index: diagnosis.index, find: String(diagnosis.patch.find), names: [...names], modules: diagnosis.modules });
        }
    }
    return { plugins, stats: evi.stats && typeof evi.stats === "object" ? { ...evi.stats } : null, unrun, unreadable };
}

export const readPerf = (send: Send) => pageCall(send, perfPage, []);

const ms = (value: number) => value >= 100 ? `${Math.round(value)} ms` : `${value.toFixed(1)} ms`;

export function perfLines({ plugins, stats, unrun, unreadable }: PerfReport, sites: number): string[] {
    const out: string[] = [];
    if (stats) out.push(`Evi on module loading: ${stats.modules} modules, ${stats.patchedModules} patched, patching ${ms(stats.patchMs)}, listeners ${ms(stats.listenerMs)}`);
    out.push(plugins.length ? `${plugins.length} plugins ran code, by time in the last 10 seconds, then since start` : "No plugin has run code that Evi measures.");
    for (const plugin of plugins) {
        out.push(`  ${plugin.plugin}  ${ms(plugin.ms)} in ${plugin.calls} calls, slowest ${ms(plugin.max)}  last 10 s: ${ms(plugin.recent.ms)} in ${plugin.recent.calls}`);
        for (const site of plugin.sites.slice(0, sites)) out.push(`    ${site.kind.padEnd(7)} ${site.name}  ${ms(site.ms)} in ${site.calls}, slowest ${ms(site.max)}`);
        if (plugin.sites.length > sites) out.push(`    … ${plugin.sites.length - sites} more sites (--all shows each)`);
    }
    out.push(unrun.length ? `${unrun.length} applied patches whose $self functions haven't run: their code may wait on a screen not opened yet, or never runs` : "Every applied patch that names $self functions has called one.");
    for (const patch of unrun) {
        out.push(`  ${patch.plugin} #${patch.index} find ${clip(patch.find, 80)}  modules ${patch.modules.join(",") || "none"}  never called: ${patch.names.map(name => `$self.${name}`).join(", ")}`);
    }
    if (unreadable) out.push(`${unreadable} replacements are functions: their $self names can't be read`);
    return out;
}
