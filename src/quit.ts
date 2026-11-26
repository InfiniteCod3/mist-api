/**
 * Work for when Discord quits. Evi doesn't stop native sides then and their disposers never run:
 * whatever must not be lost or left running registers here too.
 */
import type { NativeContext } from "@evi/api/native";
import * as electron from "electron";

import { notifyEach } from "./internal.ts";
import { log } from "./native-log.ts";

const runs = new WeakMap<NativeContext, Set<() => void>>();

/**
 * Runs `fn` when Discord quits during this native run, on Electron's `will-quit`, and on Node's
 * `exit` for Evi's restarts, whose app.exit() skips Electron's quit events. Synchronous file writes
 * still work in both. Each run adds one listener of each and removes them when it stops: hot reloads
 * don't add up. `fn` may run twice and must be safe to repeat. Returns a function that drops `fn`.
 */
export function atQuit(ctx: NativeContext, fn: () => void): () => void {
    let fns = runs.get(ctx);
    if (!fns) {
        const mine = fns = new Set();
        runs.set(ctx, mine);
        const quit = () => notifyEach(mine, [], (_, err) => log.error("atQuit: a quit handler threw", err));
        electron.app?.on("will-quit", quit);
        process.on("exit", quit);
        ctx.onDispose(() => {
            electron.app?.removeListener("will-quit", quit);
            process.removeListener("exit", quit);
            runs.delete(ctx);
        });
    }
    fns.add(fn);
    return () => void fns.delete(fn);
}
