/** The native side's log: kept for `mist native-logs` once defineNative runs, and printed to main's stdout. */
import type { LogLevel } from "./protocol.ts";
import type { Recorder } from "./recorder.ts";

/** The defineNative run that records the log. `prefix` names the plugin once its native side starts. */
export interface LogOwner {
    readonly recorder: Recorder;
    prefix: string;
}

interface EarlyLine { at: number; level: LogLevel; args: unknown[]; }

/** Bounded like the default ring */
const EARLY_MAX = 200;

let owner: LogOwner | undefined;
const early: EarlyLine[] = [];

export function write(level: LogLevel, args: unknown[]) {
    if (owner) owner.recorder.log(level, args);
    else if (early.push({ at: Date.now(), level, args }) > EARLY_MAX) early.shift();
    console[level](owner?.prefix ?? "[mist]", ...args);
}

/** Logging for native code: kept for `mist native-logs` and printed to main's stdout */
export const log = {
    log: (...args: unknown[]) => write("log", args),
    debug: (...args: unknown[]) => write("debug", args),
    info: (...args: unknown[]) => write("info", args),
    warn: (...args: unknown[]) => write("warn", args),
    error: (...args: unknown[]) => write("error", args),
};

export const hasOwner = () => owner !== undefined;

/** Records the lines logged before an owner existed into `recorder`, at the times they were logged */
function flushEarly(recorder: Recorder) {
    for (const line of early.splice(0)) recorder.log(line.level, line.args, line.at);
}

/** Makes `next` the log's owner, after recording the early lines into its recorder */
export function setOwner(next: LogOwner) {
    flushEarly(next.recorder);
    owner = next;
}
