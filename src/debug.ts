/**
 * The debug gate: a page-wide handle that shows values reduced and can't call, and a capability that
 * shows the page's records whole and, once main has a debugging port, calls native methods and asks
 * the native side for its records whole. docs/security.md has why.
 */
import type { PluginContext } from "@evi/api";

import { type CallRecord, errorMessage, HIDDEN, type LogRecord, MIST_VERSION, type NativeLogs, type ReducedNativeLogs, type Shown } from "./protocol.ts";
import type { Recorder } from "./recorder.ts";
import type { HandleState, MistHandle, NativeKind } from "./registry.ts";
import { describe, type Reduced, type Snapshot } from "./values.ts";

/** The full view of one plugin, for a debugger over CDP */
export interface MistCapability {
    readonly plugin: string;
    readonly mistVersion: string;
    /** Whether `call` works and native records come whole: main has a debugging port, as the plugin's native side says */
    open(): boolean;
    logs(n?: number): LogRecord<Snapshot>[];
    calls(n?: number): CallRecord<Snapshot>[];
    nativeLogs(n?: number): Promise<NativeLogs | null>;
    values(): Record<string, Snapshot>;
    settings(): Record<string, Snapshot> | null;
    /** Calls a native method, recorded like any other call */
    call(method: string, ...args: unknown[]): Promise<Shown>;
}

/** What the native side answered when asked whether main has a debugging port */
export type NativeGate =
    | { kind: "unknown"; }
    | { kind: "none"; }
    | { kind: "plain"; }
    | { kind: "mist"; debug: boolean; };

export interface DebugSource {
    id: string;
    recorder: Recorder;
    exposed: ReadonlyMap<string, () => unknown>;
    context(): PluginContext<any> | undefined;
    startedAt(): number | null;
    callNative(method: string, args: unknown[]): Promise<unknown>;
    provides: Readonly<Record<string, number>>;
    warnings(): string[];
    /** Whether `value` is the plugin's mist object */
    owns(value: unknown): boolean;
}

export interface Debug {
    handle: MistHandle;
    capability: MistCapability;
    /** Asks the native side until it answers; later calls get that answer */
    probe(context: PluginContext<any>): Promise<NativeGate>;
}

/**
 * What a handle is made from. Its private field is how a debugger finds the capability: CDP's
 * Runtime.getProperties lists an object's private fields, and no page code can read them or put the
 * real capability into one of its own objects.
 */
class Sealed {
    readonly #capability: MistCapability;
    constructor(capability: MistCapability) {
        this.#capability = capability;
    }
}

export function createDebug(source: DebugSource): Debug {
    const { id, recorder, exposed } = source;
    let gate: NativeGate = { kind: "unknown" };
    let probing: Promise<NativeGate> | undefined;

    // Main's argv doesn't change while Discord runs, so an answer holds for this copy's lifetime. A
    // rejection isn't one: a plain native module and a failed IPC look the same, so it's asked again.
    function probe(context: PluginContext<any>): Promise<NativeGate> {
        if (probing) return probing;
        let pending: Promise<unknown>;
        try {
            pending = context.native.call(HIDDEN.debugAllowed);
        } catch {
            // Evi throws right away for a plugin without a native module
            return probing = Promise.resolve(gate = { kind: "none" });
        }
        return probing = pending.then(
            answer => gate = { kind: "mist", debug: answer === true },
            () => {
                probing = undefined;
                return gate = { kind: "plain" };
            },
        );
    }

    const open = () => gate.kind === "mist" && gate.debug;

    function values(full: true): Record<string, Snapshot>;
    function values(full: false): Record<string, Reduced>;
    function values(full: boolean): Record<string, Shown> {
        const out: Record<string, Shown> = {};
        for (const [name, getter] of exposed) {
            let value: Snapshot;
            try {
                value = recorder.snapshot(getter());
            } catch (err) {
                value = { error: errorMessage(err) };
            }
            out[name] = full ? value : describe(value);
        }
        return out;
    }

    function settings(full: true): Record<string, Snapshot> | null;
    function settings(full: false): Record<string, Reduced> | null;
    function settings(full: boolean): Record<string, Shown> | null {
        const context = source.context();
        if (!context) return null;
        const all = recorder.snapshot(context.settings.all) as Record<string, Snapshot>;
        return full ? all : Object.fromEntries(Object.entries(all).map(([k, v]) => [k, describe(v)]));
    }

    async function nativeLogs<L extends NativeLogs>(n: number | undefined, full: boolean): Promise<L | null> {
        const context = source.context();
        const known = context ? await probe(context) : gate;
        if (known.kind !== "mist" || !context) return null;
        return await context.native.call<L>(HIDDEN.logs, n, full);
    }

    const capability: MistCapability = Object.freeze({
        plugin: id,
        mistVersion: MIST_VERSION,
        open,
        // Only a CDP client reaches the capability, and CDP reads the page's heap anyway: the gate
        // covers what the page doesn't hold, native calls and the native side's own records
        logs: (n?: number) => recorder.logs(n, true),
        calls: (n?: number) => recorder.calls(n, true),
        nativeLogs: (n?: number) => nativeLogs(n, open()),
        values: () => values(true),
        settings: () => settings(true),
        async call(method: string, ...args: unknown[]): Promise<Shown> {
            const context = source.context();
            if (!context) throw new Error(`${id} isn't running`);
            const known = await probe(context);
            if (known.kind === "none") throw new Error(`${id} has no native module`);
            if (known.kind !== "mist") throw new Error(`${id}'s native module doesn't use defineNative, so mist can't tell whether main has a debugging port`);
            if (!known.debug) throw new Error("Discord's main process wasn't started with --remote-debugging-port");
            return recorder.snapshot(await source.callNative(method, args));
        },
    });

    const provides = Object.freeze({ ...source.provides });
    const handle: MistHandle = Object.freeze(Object.assign(new Sealed(capability), {
        id,
        mistVersion: MIST_VERSION,
        provides,
        state: (): HandleState => ({
            id,
            mistVersion: MIST_VERSION,
            running: !!source.context(),
            startedAt: source.startedAt(),
            native: gate.kind satisfies NativeKind,
            debug: open(),
            errors: recorder.errors(),
            quiet: recorder.quiet(),
            provides: { ...provides },
            warnings: source.warnings(),
        }),
        logs: (n?: number) => recorder.logs(n, false),
        calls: (n?: number) => recorder.calls(n, false),
        nativeLogs: (n?: number) => nativeLogs<ReducedNativeLogs>(n, false),
        values: () => values(false),
        settings: () => settings(false),
        call: (method: string) => Promise.reject(new Error(`Calling ${id}.${method} goes through its debug capability, which only CDP reaches: run \`mist call ${id} ${method}\``)),
        owns: (value: unknown) => source.owns(value),
    }));

    return { handle, capability, probe };
}
