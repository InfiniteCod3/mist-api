/** mist restart --wait: waits for a plugin's page side to run in the restarted Discord */
import { connect, type Connection, evaluate, sleep } from "./cdp.ts";
import { errorText } from "./format.ts";

export interface WaitDeps {
    connect(port: number): Promise<Connection>;
    evaluate<T>(send: Connection["send"], expression: string): Promise<T>;
    sleep(ms: number): Promise<void>;
    now(): number;
}

const real: WaitDeps = { connect, evaluate, sleep, now: Date.now };

export type WaitResult = { running: true; ms: number; } | { running: false; ms: number; last: string; };

interface PluginReport { id: string; state: { running?: boolean; error?: string; }; startError?: string; }

/** Why plugin `id` isn't running yet, from what `Mist.status()` answered */
function notRunning(id: string, all: PluginReport[] | null, plugin: PluginReport | undefined): string {
    if (!all) return "no mist-api plugin has loaded yet";
    if (!plugin) return `${id} hasn't registered yet`;
    if (plugin.startError) return `start error: ${plugin.startError}`;
    if (plugin.state.error) return `state unreadable: ${plugin.state.error}`;
    return `${id} is stopped`;
}

/**
 * Asks `Mist.status()` once a second until plugin `id` reports running, or `timeoutMs` passes.
 * While Discord starts nothing answers on the port, and that counts as not running yet.
 */
export async function waitForPlugin(port: number, id: string, timeoutMs: number, deps: Partial<WaitDeps> = {}): Promise<WaitResult> {
    const { connect, evaluate, sleep, now } = { ...real, ...deps };
    const start = now();
    let last = "Discord isn't answering on its debugging port yet";
    for (; ;) {
        let conn: Connection | null = null;
        try {
            conn = await connect(port);
            const all = await evaluate<PluginReport[] | null>(conn.send, `globalThis.Mist ? Mist.status() : null`);
            const plugin = all?.find(report => report.id === id);
            if (plugin?.state.running && !plugin.state.error) return { running: true, ms: now() - start };
            last = notRunning(id, all, plugin);
        } catch (err) {
            last = errorText(err);
        } finally {
            conn?.close();
        }
        if (now() - start >= timeoutMs) return { running: false, ms: now() - start, last };
        await sleep(1000);
    }
}

/** The one line `mist restart --wait` prints */
export function waitLine(id: string, result: WaitResult): string {
    const seconds = (result.ms / 1000).toFixed(1);
    return result.running ? `${id} is running, ${seconds} s after the restart` : `${id} isn't running after ${seconds} s: ${result.last}`;
}
