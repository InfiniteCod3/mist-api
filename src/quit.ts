/**
 * Work for when Discord quits. Evi doesn't stop native sides then, so their disposers never run:
 * whatever must not be lost or left running registers here too.
 */
import type { NativeContext } from "@evi/api/native";
import { app } from "electron";

const runs = new WeakMap<NativeContext, Set<() => void>>();

/**
 * Runs `fn` when Discord quits during this native run, on Electron's `will-quit`, and on Node's
 * `exit` for Evi's own restarts, whose app.exit() skips Electron's quit events. Synchronous file
 * writes still work in both. One listener of each per run, removed when the run stops, so hot
 * reloads don't add up. `fn` may run twice, so it must be safe to repeat. Returns a function that drops `fn`.
 */
export function atQuit(ctx: NativeContext, fn: () => void): () => void {
    let fns = runs.get(ctx);
    if (!fns) {
        const mine = fns = new Set();
        runs.set(ctx, mine);
        const quit = () => {
            for (const each of [...mine]) {
                try { each(); } catch (err) { console.error(`[${ctx.pluginId}] Quitting:`, err); }
            }
        };
        app.on("will-quit", quit);
        process.on("exit", quit);
        ctx.onDispose(() => {
            app.removeListener("will-quit", quit);
            process.removeListener("exit", quit);
            runs.delete(ctx);
        });
    }
    fns.add(fn);
    return () => void fns.delete(fn);
}
