/**
 * mist module: a webpack module's source as Evi's patches left it, read from the script Evi compiled
 * (sourceURL evi://modules/<id>.js, src/renderer/patching/source.ts), and its diff against Discord's original.
 */
import { CdpError, evaluate, type Listen, type Send } from "./cdp.ts";
import { enableDebugger } from "./errors.ts";

/** Where one patch's replacements match in the original source: what a change there is likely from */
export interface PatchRanges { plugin: string; index: number; ranges: [number, number][]; }
export interface ModuleInfo { id: string; original: string; loaded: boolean; patches: PatchRanges[]; }
export type Found = { kind: "module"; module: ModuleInfo; } | { kind: "matches"; ids: string[]; total: number; } | { kind: "none"; };

/**
 * Page side. A query that is a module id reads that module; any other text finds the modules whose source has it.
 * Patch ranges are measured on the source as Evi patches it, normalised as `normalize` does.
 */
function findModule(normalize: (code: string) => string, query: string, limit: number): Found {
    const E = (globalThis as any).Evi;
    const m = E.wreq?.m;
    if (!m) return { kind: "none" };
    const source = (id: string) => {
        try { return String(m[id]); } catch { return ""; }
    };
    let id: string | undefined = Object.hasOwn(m, query) ? query : undefined;
    if (!id) {
        const ids = Object.keys(m).filter(k => source(k).includes(query));
        if (ids.length !== 1) return ids.length ? { kind: "matches", ids: ids.slice(0, limit), total: ids.length } : { kind: "none" };
        id = ids[0];
    }
    const original = normalize(source(id));
    const IDENT = "(?:[A-Za-z_$][\\w$]*)";
    const patches: PatchRanges[] = [];
    for (const p of E.diagnosePatches?.() ?? []) {
        if (!p.modules.includes(id)) continue;
        const ranges: [number, number][] = [];
        for (const r of [p.patch.replace].flat()) {
            if (typeof r.match === "string") {
                for (let at = original.indexOf(r.match); at >= 0; at = original.indexOf(r.match, at + 1)) ranges.push([at, at + r.match.length]);
            } else if (r.match instanceof RegExp) {
                const flags = r.match.flags.includes("g") ? r.match.flags : `${r.match.flags}g`;
                const re = new RegExp(r.match.source.replace(/(?<!\\)\\i/g, IDENT), flags);
                for (const hit of original.matchAll(re)) ranges.push([hit.index!, hit.index! + hit[0].length]);
            }
        }
        patches.push({ plugin: p.plugin, index: p.index, ranges });
    }
    return { kind: "module", module: { id, original, loaded: !!E.wreq.c?.[id], patches } };
}

/** The last script Evi compiled for the module, as it ran: Evi compiles `0,<code>` with a sourceURL line */
export async function patchedSource(send: Send, listen: Listen, id: string): Promise<string | null> {
    const url = `evi://modules/${id}.js`;
    let scriptId: string | null = null;
    const off = listen("Debugger.scriptParsed", p => { if (p.url === url) scriptId = p.scriptId; });
    let stopDebugger = () => { };
    try {
        stopDebugger = await enableDebugger(send, listen);
        if (!scriptId) return null;
        const { scriptSource } = await send("Debugger.getScriptSource", { scriptId });
        return String(scriptSource).replace(/^0,/, "").replace(/\n\/\/# sourceURL=\S*\s*$/, "");
    } finally {
        off();
        stopDebugger();
        await send("Debugger.disable").catch(() => { });
    }
}

/** Evi's normalizeFactorySource (src/renderer/patching/source.ts): a method shorthand factory `123(e,t,n){…}` compiles as `function(e,t,n){…}` */
const normalizeFactory = (code: string) => /^(?:function\b|async\b|\()/.test(code) ? code : code.replace(/^(?:[\w$]+|"(?:[^"\\]|\\.)*")(?=\s*\()/, "function");

export const findModuleIn = (send: Send, query: string, limit: number) =>
    evaluate<Found>(send, `(${findModule})(${normalizeFactory}, ${JSON.stringify(query)}, ${JSON.stringify(limit)})`);

const TOKEN = /[A-Za-z_$][\w$]*|\d+|\s+|[^]/g;
export const tokens = (code: string) => code.match(TOKEN) ?? [];

export type Op = { kind: "same" | "del" | "add"; text: string; };

/**
 * Myers' diff over tokens, keeping V only for the steps taken, so a few patches on a module of
 * 100k tokens stay cheap. null when the two differ in more than `maxEdits` tokens.
 */
export function diffTokens(a: string[], b: string[], maxEdits = 4000): Op[] | null {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const A = a.slice(start, endA), B = b.slice(start, endB);
    const n = A.length, m = B.length;
    const offset = maxEdits + 1;
    const v = new Int32Array(2 * maxEdits + 3);
    const trace: Int32Array[] = [];
    let edits = -1;
    for (let d = 0; d <= maxEdits && edits < 0; d++) {
        trace.push(v.slice(offset - d - 1, offset + d + 2));
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && A[x] === B[y]) { x++; y++; }
            v[offset + k] = x;
            if (x >= n && y >= m) { edits = d; break; }
        }
    }
    if (edits < 0) return null;

    const reversed: Op[] = [];
    let x = n, y = m;
    for (let d = edits; d > 0; d--) {
        // trace[d] holds V for diagonals -d-1 to d+1, as it was before step d
        const prev = (k: number) => trace[d][k + d + 1];
        const k = x - y;
        const down = k === -d || (k !== d && prev(k - 1) < prev(k + 1));
        const prevX = prev(down ? k + 1 : k - 1);
        const prevY = prevX - (down ? k + 1 : k - 1);
        while (x > prevX && y > prevY) reversed.push({ kind: "same", text: A[--x] }), y--;
        if (down) reversed.push({ kind: "add", text: B[--y] });
        else reversed.push({ kind: "del", text: A[--x] });
    }
    while (x > 0 && y > 0) reversed.push({ kind: "same", text: A[--x] }), y--;

    const ops: Op[] = [];
    const push = (op: Op) => {
        const last = ops[ops.length - 1];
        if (last?.kind === op.kind) last.text += op.text;
        else ops.push({ ...op });
    };
    if (start) push({ kind: "same", text: a.slice(0, start).join("") });
    for (let i = reversed.length - 1; i >= 0; i--) push(reversed[i]);
    if (endA < a.length) push({ kind: "same", text: a.slice(endA).join("") });
    return ops;
}

export interface Hunk { at: number; removed: string; added: string; before: string; after: string; plugins: string[]; certain: boolean; }

/**
 * The changes, each with the plugins it is likely from: the plugin a `$self` (Evi.$("id")) in the
 * added code names, or else the patches whose replacements match where the change is.
 */
export function hunks(changes: Op[], patches: PatchRanges[], context = 40, join = 32): Hunk[] {
    // A short unchanged stretch between two changes joins them, as a wrap(…) of one call is one change
    const ops = changes.flatMap((op, i) => op.kind === "same" && op.text.length < join && i > 0 && i < changes.length - 1
        ? [{ kind: "del" as const, text: op.text }, { kind: "add" as const, text: op.text }]
        : [op]);
    const out: Hunk[] = [];
    let at = 0;
    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        if (op.kind === "same") {
            at += op.text.length;
            continue;
        }
        let removed = "", added = "";
        const from = at;
        for (; i < ops.length && ops[i].kind !== "same"; i++) {
            if (ops[i].kind === "del") removed += ops[i].text;
            else added += ops[i].text;
        }
        at += removed.length;
        const prevSame = ops.slice(0, i).reverse().find(o => o.kind === "same")?.text ?? "";
        const nextSame = ops[i]?.kind === "same" ? ops[i].text : "";
        const named = [...new Set([...added.matchAll(/Evi\.\$\("([^"]+)"\)/g)].map(m => m[1]))];
        const overlapping = [...new Set(patches.filter(p => p.ranges.some(([s, e]) => s <= at && e >= from)).map(p => p.plugin))];
        const likely = [...new Set([...named, ...overlapping])];
        const plugins = likely.length ? likely : [...new Set(patches.map(p => p.plugin))];
        out.push({ at: from, removed, added, before: prevSame.slice(-context), after: nextSame.slice(0, context), plugins, certain: likely.length > 0 });
        i--;
    }
    return out;
}

export function hunkLines(list: Hunk[]): string[] {
    return list.flatMap(h => [
        `@@ at ${h.at}  ${h.plugins.length ? `${h.certain ? "" : "maybe "}${h.plugins.join(", ")}` : "no patch of a plugin"}`,
        `  …${h.before}`,
        ...h.removed ? [`- ${h.removed}`] : [],
        ...h.added ? [`+ ${h.added}`] : [],
        `  ${h.after}…`,
    ]);
}

export function requireModule(found: Found, query: string): ModuleInfo {
    if (found.kind === "module") return found.module;
    if (found.kind === "none") throw new CdpError(`No webpack module has the id or the text ${query}`);
    throw new CdpError(`${found.total} modules contain ${query}: ${found.ids.join(", ")}${found.total > found.ids.length ? ", …" : ""}. Give an id, or text only one module has.`);
}

export interface ModuleReport { id: string; loaded: boolean; patchedBy: string[]; patched: string | null; original: string; hunks: Hunk[] | null; }

export async function readModule(send: Send, listen: Listen, query: string): Promise<ModuleReport> {
    const module = requireModule(await findModuleIn(send, query, 20), query);
    const patched = await patchedSource(send, listen, module.id);
    const ops = patched === null ? null : diffTokens(tokens(module.original), tokens(patched));
    return {
        id: module.id,
        loaded: module.loaded,
        patchedBy: module.patches.map(p => `${p.plugin} #${p.index}`),
        patched,
        original: module.original,
        hunks: ops && hunks(ops, module.patches),
    };
}

export function moduleLines(r: ModuleReport, diff: boolean): string[] {
    const state = r.patched !== null ? "patched" : r.loaded ? "loaded, not patched" : "not loaded yet, so not patched yet";
    const head = `module ${r.id}  ${state}${r.patchedBy.length ? `  patches: ${r.patchedBy.join(", ")}` : ""}`;
    if (!diff) return [head, r.patched ?? r.original];
    if (r.patched === null) return [head, "Nothing to diff: Evi compiled no patched copy of this module."];
    if (!r.hunks) return [head, "The patched copy differs from the original in more than 4000 tokens, too many to diff."];
    return [head, `${r.hunks.length} changes; who made each is read from $self and from where each patch's match is, so it may be wrong`, ...hunkLines(r.hunks)];
}
