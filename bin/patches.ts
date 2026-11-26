/** mist patches: Evi's patch and lookup diagnosis, problems first */
import type { Send } from "./cdp.ts";
import { clip, type PatchHealth } from "./format.ts";
import { type PageGlobal, pageCall } from "./page.ts";

export interface PatchRow { plugin: string; index: number; health: string; find: string; modules: string[]; candidates: string[]; errors: string[]; }
export interface LookupRow { plugin: string; target: string; health: string; candidates: string[]; }
export interface Diagnosis { patches: PatchRow[]; lookups: LookupRow[]; }

interface EviPatch { plugin: string; index: number; health: string; patch: { find: unknown; $mistOnDemand?: boolean; }; modules: string[]; candidates: string[]; errors: string[]; }
type PatchesPage = PageGlobal<{ Evi: { diagnosePatches(): EviPatch[]; diagnoseLookups(plugin?: string): LookupRow[]; }; }>;

/** Page side. A broken patch that onDemand() in src/patches.ts marked waits for code Discord downloads later. */
function diagnose(id: string | null): Diagnosis {
    const evi = (globalThis as PatchesPage).Evi;
    // Problems first, then patches that wait for code, then the healthy ones
    const rank = (health: string) => {
        if (["broken", "failed", "partial", "ambiguous", "missing"].includes(health)) return 0;
        return health === "waiting" ? 1 : 2;
    };
    const patches = evi.diagnosePatches().filter(diagnosis => !id || diagnosis.plugin === id).map(diagnosis => ({
        plugin: diagnosis.plugin,
        index: diagnosis.index,
        health: diagnosis.health === "broken" && diagnosis.patch.$mistOnDemand === true ? "waiting" : diagnosis.health,
        find: String(diagnosis.patch.find),
        modules: diagnosis.modules,
        candidates: diagnosis.candidates,
        errors: diagnosis.errors,
    }));
    const lookups = evi.diagnoseLookups(id ?? undefined).map(lookup => ({ plugin: lookup.plugin, target: lookup.target, health: lookup.health, candidates: lookup.candidates }));
    return { patches: patches.sort((a, b) => rank(a.health) - rank(b.health)), lookups: lookups.sort((a, b) => rank(a.health) - rank(b.health)) };
}

/** Every plugin's patches and lookups, or only `plugin`'s */
export const readPatches = (send: Send, plugin?: string) => pageCall(send, diagnose, [plugin ?? null]);

/** One plugin's patches counted by health, with the ones neither applied nor waiting */
export function patchHealth({ patches }: Diagnosis): PatchHealth {
    const health: Record<string, number> = {};
    for (const patch of patches) health[patch.health] = (health[patch.health] ?? 0) + 1;
    const problems = patches
        .filter(patch => patch.health !== "applied" && patch.health !== "waiting")
        .map(({ index, health, find, errors }) => ({ index, health, find, errors }));
    return { health, problems };
}

const ERROR_INDENT = "\n            ";

function patchLine(patch: PatchRow): string {
    const modules = patch.modules.length ? `  modules ${patch.modules.join(",")}` : "";
    const errors = patch.errors.length ? ERROR_INDENT + patch.errors.join(ERROR_INDENT) : "";
    return `  ${patch.health.padEnd(9)} ${patch.plugin} #${patch.index} find ${clip(patch.find, 120)}${modules}${errors}`;
}

const lookupLine = (lookup: LookupRow) =>
    `  ${lookup.health.padEnd(9)} ${lookup.plugin} ${lookup.target}${lookup.candidates.length ? `  candidates ${lookup.candidates.join(",")}` : ""}`;

export function patchLines({ patches, lookups }: Diagnosis): string[] {
    return [`${patches.length} patches`, ...patches.map(patchLine), `${lookups.length} lookups`, ...lookups.map(lookupLine)];
}
