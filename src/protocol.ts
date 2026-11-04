/**
 * Shapes shared by the page side, the native side and the CLI. Changing one is a protocol change:
 * bundled copies of different versions read each other's records through the registry.
 */
import type { Reduced, Snapshot } from "./values.ts";

export const MIST_VERSION = "0.2.1";

/** Native methods every defineNative module has; the page client never lists them */
export const HIDDEN = { debugAllowed: "__mist_debugAllowed", logs: "__mist_logs", events: "__mist_events" } as const;
export type HiddenMethod = typeof HIDDEN[keyof typeof HIDDEN];

export type LogLevel = "log" | "debug" | "info" | "warn" | "error";

export interface LogRecord<V = Snapshot> {
    at: number;
    level: LogLevel;
    args: V[];
}

export type CallOutcome<V> =
    | { state: "pending"; }
    | { state: "ok"; ms: number; result: V; }
    | { state: "error"; ms: number; message: [V] extends [Reduced] ? Reduced : string; };

export interface CallRecord<V = Snapshot> {
    method: string;
    /** Date.now() when it began */
    at: number;
    args: V[];
    outcome: CallOutcome<V>;
}

/** A value as a view that may be open shows it: whole (secrets masked), or reduced */
export type Shown = Snapshot | Reduced;

/** What `__mist_logs` answers. `full` is false unless asked for and main has a debugging port. */
export type NativeLogs =
    | { full: true; calls: CallRecord<Snapshot>[]; logs: LogRecord<Snapshot>[]; quiet?: Record<string, number>; }
    | ReducedNativeLogs;
/** `quiet` counts the calls of each quiet method, which aren't in `calls` */
export type ReducedNativeLogs = { full: false; calls: CallRecord<Reduced>[]; logs: LogRecord<Reduced>[]; quiet?: Record<string, number>; };

export const errorMessage = (err: unknown) => err instanceof Error ? err.message : String(err);

/**
 * What `__mist_events` answers. `fresh` means the page has to load its state again before it
 * applies `events`: it just connected, the native side restarted, or it fell behind the kept log.
 */
export interface EventsAnswer<E> {
    /** The channel's id for this run of the native side */
    boot: string;
    /** Where the next poll continues from */
    cursor: number;
    fresh: boolean;
    events: E[];
}
