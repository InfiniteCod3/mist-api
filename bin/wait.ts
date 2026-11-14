/** mist restart --wait: waits for a plugin's page side to run in the restarted Discord */
import { connect, type Connection, evaluate } from "./cdp.ts";

export interface WaitDeps {
    connect(port: number): Promise<Connection>;
    evaluate<T>(send: Connection["send"], expression: string): Promise<T>;
    sleep(ms: number): Promise<void>;
    now(): number;
}

const real: WaitDeps = { connect, evaluate, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now };

export type WaitResult = { running: true; ms: number; } | { running: false; ms: number; last: string; };

/**
 * Asks `Mist.status()` once a second until plugin `id` reports running, or `timeoutMs` passes.
 * While Discord starts nothing answers on the port, and that counts as not running yet.
 */
export async function waitForPlugin(port: number, id: string, timeoutMs: number, deps: Partial<WaitDeps> = {}): Promise<WaitResult> {
    const { connect, evaluate, sleep, now } = { ...real, ...deps };
    const start = now();
    let last = "Discord isn't answering on its debugging port yet";
    for (; ;) {
        let c: Connection | null = null;
        try {
            c = await connect(port);
            const all = await evaluate<{ id: string; state: { running?: boolean; error?: string; }; startError?: string; }[] | null>(c.send, `globalThis.Mist ? Mist.status() : null`);
            const plugin = all?.find(p => p.id === id);
            if (plugin?.state.running && !plugin.state.error) return { running: true, ms: now() - start };
            last = !all ? "no mist-api plugin has loaded yet"
                : !plugin ? `${id} hasn't registered yet`
                    : plugin.startError ? `start error: ${plugin.startError}`
                        : plugin.state.error ? `state unreadable: ${plugin.state.error}`
                            : `${id} is stopped`;
        } catch (err) {
            last = (err as Error).message;
        } finally {
            c?.close();
        }
        if (now() - start >= timeoutMs) return { running: false, ms: now() - start, last };
        await sleep(1000);
    }
}

/** The one line `mist restart --wait` prints */
export function waitLine(id: string, r: WaitResult): string {
    const s = (r.ms / 1000).toFixed(1);
    return r.running ? `${id} is running, ${s} s after the restart` : `${id} isn't running after ${s} s: ${r.last}`;
}
