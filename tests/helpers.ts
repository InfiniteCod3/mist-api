import type { PluginContext } from "@evi/api";

export type NativeImpl = (method: string, ...args: unknown[]) => Promise<unknown>;

/** A native side made with defineNative: answers the debug question, then `methods` */
export const mistNative = (debug: boolean, methods: Record<string, (...args: any[]) => unknown> = {}): NativeImpl =>
    async (method, ...args) => {
        if (method === "__mist_debugAllowed") return debug;
        if (method === "__mist_logs") return { full: debug && args[1] === true, calls: [], logs: [] };
        const fn = methods[method];
        if (!fn) throw new Error(`no native method ${method}`);
        return fn(...args);
    };

/** Evi's answer for a plugin with no native module: it throws before any IPC */
export const noNative: NativeImpl = () => {
    throw new Error("has no native module");
};

/** A native module without defineNative: the hidden method doesn't exist */
export const plainNative = (methods: Record<string, (...args: any[]) => unknown> = {}): NativeImpl =>
    async (method, ...args) => {
        const fn = methods[method];
        if (!fn) throw new Error(`no native method ${method}`);
        return fn(...args);
    };

/** Enough of Evi's PluginContext for mist: native calls, logger, settings, onDispose */
export function fakeContext(native: NativeImpl, settings: Record<string, unknown> = {}, id = "test") {
    const disposers: (() => void)[] = [];
    const printed: { level: string; args: unknown[]; }[] = [];
    const logger = Object.fromEntries(["log", "debug", "info", "warn", "error"].map(level => [level, (...args: unknown[]) => void printed.push({ level, args })]));
    const ctx = {
        id,
        native: { call: native },
        logger,
        settings: { all: settings },
        onDispose: (fn: () => void) => void disposers.push(fn),
    } as unknown as PluginContext<any>;
    return {
        ctx,
        printed,
        /** What Evi does on stop: disposers, newest first */
        dispose: () => { for (const fn of disposers.splice(0).reverse()) fn(); },
    };
}

/** Lets pending promise callbacks run */
export const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Evi's IPC to a native module: start and stop aren't callable, arguments and results are
 * structured-cloned, and Electron turns a throw into a plain Error with a prefixed message.
 */
export function electronBridge(module: object, calls: { method: string; args: unknown[]; }[] = []): NativeImpl {
    return async (method, ...args) => {
        calls.push({ method, args });
        const fn = (module as Record<string, unknown>)[method];
        if (typeof fn !== "function" || method === "start" || method === "stop") throw new Error(`Error invoking remote method 'evi:plugin-native-call': Error: Plugin test has no native method ${method}`);
        try {
            return structuredClone(await fn.apply(module, structuredClone(args)));
        } catch (err) {
            throw new Error(`Error invoking remote method 'evi:plugin-native-call': ${err}`);
        }
    };
}
