/**
 * mist leaks: turns a dev build off and on, counting what the page holds after each stop and each
 * start. A count that grows with every cycle is what a stop left behind. This changes the plugin's
 * switch, so it runs only on dev builds, and leaves the plugin on.
 */
import { CdpError, evaluate, type Send } from "./cdp.ts";
import { pageExpression } from "./page.ts";

export interface Counts {
    /** Elements in the document */
    nodes: number | null;
    /** <style> and stylesheet <link> elements, and adopted sheets */
    styles: number | null;
    /** Flux handlers subscribed through Dispatcher.subscribe */
    subscribers: number | null;
    interceptors: number | null;
    /** Event listeners on the page, from CDP's Performance.getMetrics (JSEventListeners) */
    listeners: number | null;
}
export const COUNTS: (keyof Counts)[] = ["nodes", "styles", "subscribers", "interceptors", "listeners"];
export interface Cycle { off: Counts; on: Counts; }
export interface LeakReport { plugin: string; before: Counts; cycles: Cycle[]; growth: Partial<Record<keyof Counts, number>>; }

function plugin(id: string): { source: string; running: boolean; } | null {
    const s = (globalThis as any).Evi?.plugins?.get(id);
    return s ? { source: s.source, running: s.running } : null;
}

function measure(): Omit<Counts, "listeners"> {
    const D = (globalThis as any).Evi?.api?.Dispatcher;
    const doc = typeof document === "undefined" ? null : document;
    let subscribers: number | null = null;
    try {
        subscribers = Object.values(D._subscriptions as Record<string, Set<unknown>>).reduce((n, set) => n + set.size, 0);
    } catch { }
    return {
        nodes: doc ? doc.getElementsByTagName("*").length : null,
        styles: doc ? doc.querySelectorAll("style, link[rel=stylesheet]").length + (doc.adoptedStyleSheets?.length ?? 0) : null,
        subscribers,
        interceptors: Array.isArray(D?._interceptors) ? D._interceptors.length : null,
    };
}

export interface LeakOptions {
    cycles: number;
    /** Wait after each switch before counting, for the page to settle */
    settleMs?: number;
    /** How long a start may take */
    startMs?: number;
    onCycle?: (cycle: Cycle, index: number) => void;
}

/** Refuses anything but a dev build that is running, before it changes anything */
export async function checkLeakTarget(send: Send, id: string): Promise<void> {
    const found = await evaluate<{ source: string; running: boolean; } | null>(send, pageExpression(plugin, [id]));
    if (!found) throw new CdpError(`${id} isn't installed`);
    if (found.source !== "dev") throw new CdpError(`mist leaks turns plugins off and on, so it runs only on dev builds, and ${id} is a ${found.source} install`);
    if (!found.running) throw new CdpError(`${id} isn't running: turn it on first, so mist leaks can leave it as it was`);
}

export async function findLeaks(send: Send, id: string, options: LeakOptions): Promise<LeakReport> {
    const { cycles, settleMs = 1500, startMs = 10_000 } = options;
    await checkLeakTarget(send, id);
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const listeners = async (): Promise<number | null> => {
        try {
            const { metrics } = await send("Performance.getMetrics");
            return metrics.find((m: { name: string; }) => m.name === "JSEventListeners")?.value ?? null;
        } catch {
            return null;
        }
    };
    const count = async (): Promise<Counts> => ({ ...await evaluate<Omit<Counts, "listeners">>(send, pageExpression(measure, [])), listeners: await listeners() });
    const setEnabled = (on: boolean) => evaluate(send, `Evi.plugins.setEnabled(${JSON.stringify(id)}, ${on})`);

    await send("Performance.enable").catch(() => { });
    let turnedOff = false;
    try {
        await wait(settleMs);
        const before = await count();
        const done: Cycle[] = [];
        for (let i = 0; i < cycles; i++) {
            await setEnabled(false);
            turnedOff = true;
            await wait(settleMs);
            const off = await count();
            await setEnabled(true);
            turnedOff = false;
            const until = Date.now() + startMs;
            while (!(await evaluate<{ running: boolean; } | null>(send, pageExpression(plugin, [id])))?.running) {
                if (Date.now() > until) throw new CdpError(`${id} didn't start again within ${startMs / 1000} s: mist errors ${id} shows why`);
                await wait(100);
            }
            await wait(settleMs);
            const cycle = { off, on: await count() };
            done.push(cycle);
            options.onCycle?.(cycle, i);
        }
        return { plugin: id, before, cycles: done, growth: growth(before, done) };
    } finally {
        if (turnedOff) await setEnabled(true).catch(() => { });
        await send("Performance.disable").catch(() => { });
    }
}

/**
 * How much each count rose per cycle, for counts that rose after every start and after every stop.
 * Discord changes the page on its own too, so one cycle's rise alone isn't counted.
 */
export function growth(before: Counts, cycles: Cycle[]): Partial<Record<keyof Counts, number>> {
    const out: Partial<Record<keyof Counts, number>> = {};
    for (const key of COUNTS) {
        const on = [before[key], ...cycles.map(c => c.on[key])];
        const off = cycles.map(c => c.off[key]);
        if (on.some(v => v === null) || off.some(v => v === null)) continue;
        const rising = (list: (number | null)[]) => list.every((v, i) => i === 0 || v! > list[i - 1]!);
        if (cycles.length >= 2 && rising(on) && rising(off)) out[key] = (on[on.length - 1]! - on[0]!) / cycles.length;
    }
    return out;
}

export function leakLines(r: LeakReport): string[] {
    const shown = COUNTS.filter(k => r.before[k] !== null);
    const row = (label: string, c: Counts) => `  ${label.padEnd(12)} ${shown.map(k => `${k} ${c[k]! - r.before[k]! >= 0 ? "+" : ""}${c[k]! - r.before[k]!}`).join("  ")}`;
    const out = [`${r.plugin}: ${r.cycles.length} off and on cycles, counts against before the first (${shown.map(k => `${k} ${r.before[k]}`).join(", ")})`];
    r.cycles.forEach((c, i) => out.push(row(`${i + 1} off`, c.off), row(`${i + 1} on`, c.on)));
    const grew = Object.entries(r.growth);
    if (r.cycles.length < 2) out.push("One cycle can't tell a leak from Discord changing the page: use --cycles 3 or more.");
    else if (!grew.length) out.push("Nothing grew with every cycle.");
    else for (const [key, per] of grew) out.push(`LEAK? ${key} grew after every stop and every start, about ${Math.round(per! * 10) / 10} per cycle`);
    return out;
}
