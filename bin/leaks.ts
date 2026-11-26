/**
 * mist leaks: turns a dev build off and on, counting what the page holds after each stop and each
 * start. A count that grows with every cycle is what a stop left behind. It changes the plugin's
 * switch: it runs only on dev builds that stay in Discord's page, and leaves the plugin on.
 */
import { CliError, evaluate, type Send, sleep } from "./cdp.ts";
import { errorText } from "./format.ts";
import { type PageGlobal, pageCall } from "./page.ts";

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
const COUNTS: (keyof Counts)[] = ["nodes", "styles", "subscribers", "interceptors", "listeners"];
export interface Cycle { off: Counts; on: Counts; }
export interface LeakReport { plugin: string; before: Counts; cycles: Cycle[]; growth: Partial<Record<keyof Counts, number>>; }

interface LeakTarget { source: string; running: boolean; native: boolean; switches: boolean; }

interface PluginSnapshot { source: string; running: boolean; manifest?: { native?: string; chromiumSwitches?: Record<string, string>; }; }
type LeaksPage = PageGlobal<{ Evi?: { plugins?: { get(id: string): PluginSnapshot | undefined; }; api?: { Dispatcher?: { _subscriptions?: Record<string, Set<unknown>>; _interceptors?: unknown[]; }; }; }; }>;

function plugin(id: string): LeakTarget | null {
    const snapshot = (globalThis as LeaksPage).Evi?.plugins?.get(id);
    if (!snapshot) return null;
    const switches = Object.keys(snapshot.manifest?.chromiumSwitches ?? {}).length > 0;
    return { source: snapshot.source, running: snapshot.running, native: !!snapshot.manifest?.native, switches };
}

function measure(): Omit<Counts, "listeners"> {
    const dispatcher = (globalThis as LeaksPage).Evi?.api?.Dispatcher;
    const doc = typeof document === "undefined" ? null : document;
    let subscribers: number | null = null;
    try {
        const subscriptions = dispatcher?._subscriptions;
        if (subscriptions) subscribers = Object.values(subscriptions).reduce((n, set) => n + set.size, 0);
    } catch { }
    return {
        nodes: doc ? doc.getElementsByTagName("*").length : null,
        styles: doc ? doc.querySelectorAll("style, link[rel=stylesheet]").length + (doc.adoptedStyleSheets?.length ?? 0) : null,
        subscribers,
        interceptors: Array.isArray(dispatcher?._interceptors) ? dispatcher._interceptors.length : null,
    };
}

export interface LeakOptions {
    cycles: number;
    /** Wait after each switch before counting, for the page to settle */
    settleMs?: number;
    /** How long a start may take */
    startMs?: number;
    onCycle?: (cycle: Cycle, index: number) => void;
    /** Checked between steps: true ends the run, with the plugin on again */
    stopped?: () => boolean;
}

/** Refuses anything but a running dev build that stays in Discord's page, before it changes anything */
export async function checkLeakTarget(send: Send, id: string): Promise<void> {
    const found = await pageCall(send, plugin, [id]);
    if (!found) throw new CliError(`${id} isn't installed`);
    if (found.source !== "dev") throw new CliError(`mist leaks runs only on dev builds: ${id} is a ${found.source} install`);
    // src/main/plugins.ts askToEnable: main asks the user before each turn-on of such a plugin
    if (found.native || found.switches) throw new CliError(`mist leaks can't turn ${id} on again by itself: it has ${found.native ? "a native side" : "Chromium switches"}, and Evi asks yes or no each time it is turned on`);
    if (!found.running) throw new CliError(`${id} isn't running: turn it on first, and mist leaks leaves it on`);
}

export async function findLeaks(send: Send, id: string, options: LeakOptions): Promise<LeakReport> {
    const { cycles, settleMs = 1500, startMs = 10_000, stopped = () => false } = options;
    await checkLeakTarget(send, id);
    const step = () => {
        if (stopped()) throw new CliError(`mist leaks stopped at Ctrl+C. ${id} is on.`);
    };
    const listeners = async (): Promise<number | null> => {
        try {
            const { metrics } = await send("Performance.getMetrics");
            return metrics.find((metric: { name: string; }) => metric.name === "JSEventListeners")?.value ?? null;
        } catch {
            return null;
        }
    };
    const count = async (): Promise<Counts> => ({ ...await pageCall(send, measure, []), listeners: await listeners() });
    const setEnabled = (on: boolean) => evaluate(send, `Evi.plugins.setEnabled(${JSON.stringify(id)}, ${on})`);

    await send("Performance.enable").catch(() => { });
    let turnedOff = false;
    try {
        await sleep(settleMs);
        step();
        const before = await count();
        const done: Cycle[] = [];
        for (let i = 0; i < cycles; i++) {
            step();
            // Before the call: a turn-off that fails or times out may still have turned it off
            turnedOff = true;
            await setEnabled(false);
            await sleep(settleMs);
            step();
            const off = await count();
            await setEnabled(true);
            turnedOff = false;
            const until = Date.now() + startMs;
            while (!(await pageCall(send, plugin, [id]))?.running) {
                if (Date.now() > until) throw new CliError(`${id} didn't start again within ${startMs / 1000} s: mist errors ${id} shows why`);
                await sleep(100);
            }
            await sleep(settleMs);
            step();
            const cycle = { off, on: await count() };
            done.push(cycle);
            options.onCycle?.(cycle, i);
        }
        return { plugin: id, before, cycles: done, growth: growth(before, done) };
    } finally {
        const turnOnError = turnedOff ? await setEnabled(true).then(() => null, errorText) : null;
        await send("Performance.disable").catch(() => { });
        if (turnOnError !== null) throw new CliError(`${id} may be off: turning it on again failed (${turnOnError}). Turn it on in Evi's settings.`);
    }
}

/**
 * How much each count rose per cycle, for counts that rose after every start and after every stop.
 * Discord changes the page by itself too: one cycle's rise alone isn't counted.
 */
export function growth(before: Counts, cycles: Cycle[]): Partial<Record<keyof Counts, number>> {
    const out: Partial<Record<keyof Counts, number>> = {};
    for (const key of COUNTS) {
        const on = [before[key], ...cycles.map(cycle => cycle.on[key])];
        const off = cycles.map(cycle => cycle.off[key]);
        if (on.some(count => count === null) || off.some(count => count === null)) continue;
        const rising = (list: (number | null)[]) => list.every((count, i) => i === 0 || count! > list[i - 1]!);
        if (cycles.length >= 2 && rising(on) && rising(off)) out[key] = (on[on.length - 1]! - on[0]!) / cycles.length;
    }
    return out;
}

export function leakLines(report: LeakReport): string[] {
    const shown = COUNTS.filter(key => report.before[key] !== null);
    const change = (counts: Counts, key: keyof Counts) => {
        const diff = counts[key]! - report.before[key]!;
        return `${key} ${diff >= 0 ? "+" : ""}${diff}`;
    };
    const row = (label: string, counts: Counts) => `  ${label.padEnd(12)} ${shown.map(key => change(counts, key)).join("  ")}`;
    const out = [`${report.plugin}: ${report.cycles.length} off and on cycles, counts against before the first (${shown.map(key => `${key} ${report.before[key]}`).join(", ")})`];
    report.cycles.forEach((cycle, i) => out.push(row(`${i + 1} off`, cycle.off), row(`${i + 1} on`, cycle.on)));
    const grew = Object.entries(report.growth);
    if (report.cycles.length < 2) out.push("One cycle can't tell a leak from Discord changing the page: use --cycles 3 or more.");
    else if (!grew.length) out.push("Nothing grew with every cycle.");
    else for (const [key, perCycle] of grew) out.push(`LEAK? ${key} grew after every stop and every start, about ${Math.round(perCycle! * 10) / 10} per cycle`);
    return out;
}
