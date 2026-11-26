/** mist status: every mist-api plugin on the page, from window.Mist.status() (src/registry.ts status) */
import { CliError, evaluate, type Send } from "./cdp.ts";
import { healthCounts, type PatchHealth, patchHealthLines } from "./format.ts";

interface HandleState {
    running: boolean;
    native: string;
    debug: boolean;
    errors: { calls: number; logs: number; };
    quiet?: Record<string, number>;
    warnings?: string[];
}
interface LookupHealth { health: Record<string, number>; problems: { target: string; health: string; }[]; }
/** A part of the status the page couldn't read */
type Unreadable = { error: string; };

export interface PluginStatus {
    id: string;
    mistVersion: string;
    state: HandleState | Unreadable;
    startError?: string | null;
    registry?: { registered: number; replaced: number; } | null;
    concerns?: string[] | null;
    patches?: PatchHealth | Unreadable | null;
    lookups?: LookupHealth | Unreadable | null;
}

export async function readStatus(send: Send): Promise<PluginStatus[]> {
    const all = await evaluate<PluginStatus[] | null>(send, `globalThis.Mist ? Mist.status() : null`);
    if (all === null) throw new CliError("No mist-api plugin has loaded on this page");
    return all;
}

/** Quiet methods' call counts, as in "poll 12". A copy that sends no counts shows none. */
export const quietCounts = (quiet: Record<string, number> | undefined) => Object.entries(quiet ?? {}).map(([method, n]) => `${method} ${n}`).join(", ");

function stateLines(plugin: PluginStatus): string[] {
    const state = plugin.state;
    if ("error" in state) return [`${plugin.id}  (state unreadable: ${state.error})`];
    const out = [`${plugin.id}  ${state.running ? "running" : "stopped"}  mist ${plugin.mistVersion}  native: ${state.native}${state.debug ? " (debug open)" : ""}  errors: ${state.errors.calls} calls, ${state.errors.logs} logs`];
    if (quietCounts(state.quiet)) out.push(`  quiet calls, counted and not kept: ${quietCounts(state.quiet)}`);
    return out;
}

function lookupLines(lookups: LookupHealth | Unreadable): string[] {
    if ("error" in lookups) return [`  lookups: ${lookups.error}`];
    return [`  lookups: ${healthCounts(lookups.health)}`, ...lookups.problems.map(problem => `    ${problem.health} ${problem.target}`)];
}

export function statusLines(all: PluginStatus[]): string[] {
    if (!all.length) return ["No mist-api plugin has registered on this page."];
    return all.flatMap(plugin => {
        const out = stateLines(plugin);
        if (plugin.startError) out.push(`  start error: ${plugin.startError}`);
        const registry = plugin.registry;
        if (registry && registry.registered > 1) out.push(`  registry: registered ${registry.registered} times, ${registry.replaced} replacing another handle (a hot reload replaces one)`);
        // A concern is the registry doubting the handle; a warning is the plugin's note about itself
        for (const concern of plugin.concerns ?? []) out.push(`  concern: ${concern}`);
        if (!("error" in plugin.state)) for (const warning of plugin.state.warnings ?? []) out.push(`  warning: ${warning}`);
        if (plugin.patches) out.push(...("error" in plugin.patches ? [`  patches: ${plugin.patches.error}`] : patchHealthLines(plugin.patches)));
        if (plugin.lookups) out.push(...lookupLines(plugin.lookups));
        return out;
    });
}
