/** Things a native side starts that have to end when it stops: child processes, timers, windows. */
import type { NativeContext } from "@evi/api/native";
import { type ChildProcess, spawn, type SpawnOptions } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join } from "node:path";

import { NativeError } from "./errors.ts";

export interface LifetimeOptions {
    /** How long a child process gets after SIGTERM before SIGKILL. Default 3000 */
    killAfterMs?: number;
}

/** A window the scope destroys: Electron's BrowserWindow, or anything shaped like it */
interface Destroyable { isDestroyed(): boolean; destroy(): void; }

export interface Lifetime {
    /** Aborts when the native side stops */
    readonly signal: AbortSignal;
    /** node:child_process spawn, with the child killed on stop: SIGTERM, then SIGKILL after killAfterMs */
    spawn(file: string, args?: readonly string[], options?: SpawnOptions): ChildProcess;
    /** setInterval, cleared on stop. Returns a function that clears it sooner. */
    interval(fn: () => void, ms: number): () => void;
    /** setTimeout, cleared on stop. Returns a function that clears it sooner. */
    timeout(fn: () => void, ms: number): () => void;
    /** Destroys `win` on stop, unless it was destroyed already. Returns `win`. */
    window<W extends Destroyable>(win: W): W;
}

/** Ends a child: SIGTERM now, SIGKILL if it hasn't exited after `ms`. The timer doesn't keep main alive. */
export function killWithEscalation(child: ChildProcess, ms: number) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, ms);
    timer.unref?.();
    child.once("exit", () => clearTimeout(timer));
}

/**
 * A scope for one run of the native side: what it starts is cleaned up when the run stops, through
 * `ctx.onDispose`. Make one in `start`. Using it after the stop throws a NativeError "stopped".
 */
export function lifetime(ctx: NativeContext, { killAfterMs = 3000 }: LifetimeOptions = {}): Lifetime {
    const controller = new AbortController();
    const cleanups = new Set<() => void>();
    const live = () => {
        if (controller.signal.aborted) throw new NativeError("stopped", undefined, `${ctx.pluginId}'s native side stopped`);
    };
    const track = (cleanup: () => void) => {
        cleanups.add(cleanup);
        return () => {
            if (cleanups.delete(cleanup)) cleanup();
        };
    };

    ctx.onDispose(() => {
        controller.abort(new Error(`${ctx.pluginId}'s native side stopped`));
        for (const cleanup of [...cleanups]) {
            cleanups.delete(cleanup);
            try { cleanup(); } catch { }
        }
    });

    return {
        signal: controller.signal,
        spawn(file, args = [], options = {}) {
            live();
            const child = spawn(file, args, options);
            const stop = () => killWithEscalation(child, killAfterMs);
            cleanups.add(stop);
            child.once("exit", () => cleanups.delete(stop));
            // Without a listener, a child that fails to start would throw in main
            child.once("error", () => cleanups.delete(stop));
            return child;
        },
        interval(fn, ms) {
            live();
            const timer = setInterval(fn, ms);
            return track(() => clearInterval(timer));
        },
        timeout(fn, ms) {
            live();
            const timer = setTimeout(() => {
                cleanups.delete(clear);
                fn();
            }, ms);
            const clear = () => clearTimeout(timer);
            return track(clear);
        },
        window(win) {
            live();
            track(() => { if (!win.isDestroyed()) win.destroy(); });
            return win;
        },
    };
}

export interface RunOptions {
    /** Kills the program after this many ms and rejects with a NativeError "timeout". Default 60000 */
    timeout?: number;
    /** Kills the program and rejects with the signal's reason */
    signal?: AbortSignal;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Written to the program's stdin, which is then closed */
    input?: string;
    /** Kills the program and rejects with a NativeError "too-large" when stdout or stderr passes this. Default 10 MiB */
    maxBytes?: number;
    /** How long the program gets after SIGTERM before SIGKILL. Default 3000 */
    killAfterMs?: number;
}

export interface RunResult {
    /** The exit code, or null when a signal ended the program */
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
}

/**
 * Runs a program without a shell and collects its output. Resolves whatever the exit code: check
 * `code`. Rejects when the program can't start, on timeout, on abort, or when output is too large.
 */
export function run(file: string, args: readonly string[] = [], options: RunOptions = {}): Promise<RunResult> {
    const { timeout = 60_000, signal, cwd, env, input, maxBytes = 10 * 1024 * 1024, killAfterMs = 3000 } = options;
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        const out: Buffer[] = [], err: Buffer[] = [];
        const size = { out: 0, err: 0 };
        let failure: unknown;

        const fail = (reason: unknown) => {
            if (failure !== undefined) return;
            failure = reason;
            killWithEscalation(child, killAfterMs);
        };
        const timer = setTimeout(() => fail(new NativeError("timeout", { file, timeout }, `${file} didn't finish within ${timeout} ms`)), timeout);
        const onAbort = () => fail(signal!.reason);
        signal?.addEventListener("abort", onAbort, { once: true });

        const collect = (chunks: Buffer[], key: "out" | "err") => (chunk: Buffer) => {
            size[key] += chunk.length;
            if (size[key] > maxBytes) return fail(new NativeError("too-large", { file, maxBytes }, `${file} wrote more than ${maxBytes} bytes`));
            chunks.push(chunk);
        };
        child.stdout!.on("data", collect(out, "out"));
        child.stderr!.on("data", collect(err, "err"));
        // A program that exits without reading its input closes the pipe under the write
        child.stdin!.on("error", () => { });
        child.stdin!.end(input);

        const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };
        child.once("error", error => {
            done();
            reject(failure ?? error);
        });
        child.once("close", (code, exitSignal) => {
            done();
            if (failure !== undefined) return reject(failure);
            resolve({ code, signal: exitSignal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
        });
    });
}

async function isProgram(path: string) {
    try {
        if (!(await stat(path)).isFile()) return false;
        await access(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * The full path of a program on PATH, as a shell would find it, or null. On Windows a name without
 * an extension is tried with each of PATHEXT's. A name with a slash is checked as it is.
 */
export async function which(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
    if (!name) return null;
    const windows = process.platform === "win32";
    const pathVar = windows ? Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] : env.PATH;
    const extensions = windows && !extname(name) ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map(ext => ext.toLowerCase()) : [""];
    const candidates = (base: string) => extensions.map(ext => base + ext);

    if (isAbsolute(name) || /[\\/]/.test(name)) {
        for (const path of candidates(name)) if (await isProgram(path)) return path;
        return null;
    }
    for (const dir of (pathVar ?? "").split(delimiter)) {
        if (!dir) continue;
        for (const path of candidates(join(dir.replace(/^"(.*)"$/, "$1"), name))) if (await isProgram(path)) return path;
    }
    return null;
}
