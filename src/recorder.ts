import { type CallOutcome, type CallRecord, errorMessage, type LogLevel, type LogRecord, type Shown } from "./protocol.ts";
import { Ring } from "./ring.ts";
import { describe, MASKED, type Reduced, secretTest, type Snapshot, snapshot } from "./values.ts";

/** What a plugin can tune about its records, on the page (createMist) and the native side (defineNative) alike */
export interface RecordingOptions<Name extends string = string> {
    /** How many calls and how many log lines are kept. Default 200 */
    capacity?: number;
    /** Field and Map key names masked in recorded values, on top of the built-in ones (token, password, cookie...) */
    secrets?: readonly string[];
    /** Field and Map key names shown even though a built-in name would mask them, as in sessionId. The plugin's own secrets stay masked. */
    reveal?: readonly string[];
    /**
     * Positions of arguments masked in each method's recorded calls, counting from 0, for a secret
     * passed bare, which no field name marks: `{ login: [1] }` masks login's second argument
     */
    secretArgs?: { readonly [K in Name]?: readonly number[]; };
    /**
     * Methods whose calls are counted and not kept, such as a long poll that would push every other
     * call out of the ring. A call of one that fails is kept like any other.
     */
    quiet?: readonly Name[];
}

export interface RecorderOptions extends RecordingOptions {
    /**
     * Whether values are kept whole. When false they're reduced to type and size as they're recorded,
     * log text and error messages included, so nothing else is ever held in memory.
     */
    keepValues: boolean;
}

/** Calls and log lines of one side (page or native) of one plugin */
export type Recorder = ReturnType<typeof createRecorder>;

export function createRecorder({ capacity = 200, secrets, reveal, secretArgs = {}, quiet = [], keepValues }: RecorderOptions) {
    const calls = new Ring<CallRecord>(capacity);
    const logs = new Ring<LogRecord>(capacity);
    const isSecret = secretTest(secrets, reveal);
    const quietNames = new Set<string>(quiet);
    const quietCounts = new Map<string, number>();
    const keep = (value: unknown): Snapshot => {
        const snap = snapshot(value, isSecret);
        return keepValues ? snap : describe(snap);
    };
    // Without keepValues every record is reduced already, and reducing it again would describe the description
    const reduce = (value: Snapshot): Reduced => keepValues ? describe(value) : value as Reduced;

    function reducedOutcome(outcome: CallOutcome<Snapshot>): CallOutcome<Reduced> {
        switch (outcome.state) {
            case "pending": return outcome;
            case "ok": return { ...outcome, result: reduce(outcome.result) };
            case "error": return { ...outcome, message: reduce(outcome.message) };
        }
    }

    function shownCalls(n: number | undefined, full: true): CallRecord<Snapshot>[];
    function shownCalls(n: number | undefined, full: false): CallRecord<Reduced>[];
    function shownCalls(n: number | undefined, full: boolean): CallRecord<Shown>[];
    function shownCalls(n: number | undefined, full: boolean): CallRecord<Shown>[] {
        if (full) return calls.last(n);
        return calls.last(n).map(r => ({ ...r, args: r.args.map(reduce), outcome: reducedOutcome(r.outcome) }));
    }

    function shownLogs(n: number | undefined, full: true): LogRecord<Snapshot>[];
    function shownLogs(n: number | undefined, full: false): LogRecord<Reduced>[];
    function shownLogs(n: number | undefined, full: boolean): LogRecord<Shown>[];
    function shownLogs(n: number | undefined, full: boolean): LogRecord<Shown>[] {
        if (full) return logs.last(n);
        return logs.last(n).map(r => ({ ...r, args: r.args.map(reduce) }));
    }

    return {
        /** Runs `run` and records it as a call of `method`; a returned promise is recorded when it settles */
        track<R>(method: string, args: readonly unknown[], run: () => R): R {
            const began = performance.now();
            const hidden = Object.hasOwn(secretArgs, method) ? secretArgs[method]! : [];
            const arg = (value: unknown, i: number) => keep(hidden.includes(i) && value != null && value !== "" ? MASKED : value);
            const record: CallRecord = { method, at: Date.now(), args: args.map(arg), outcome: { state: "pending" } };
            const isQuiet = quietNames.has(method);
            if (isQuiet) quietCounts.set(method, (quietCounts.get(method) ?? 0) + 1);
            else calls.push(record);
            // A quiet call that succeeds is never shown, so its result isn't copied
            const ok = (result: unknown) => { if (!isQuiet) record.outcome = { state: "ok", ms: performance.now() - began, result: keep(result) }; };
            const fail = (err: unknown) => {
                const message = errorMessage(err);
                record.outcome = { state: "error", ms: performance.now() - began, message: keepValues ? message : describe(message) };
                if (isQuiet) calls.push(record);
            };
            let result: R;
            try {
                result = run();
            } catch (err) {
                fail(err);
                throw err;
            }
            if (result instanceof Promise) result.then(ok, fail);
            else ok(result);
            return result;
        },

        log(level: LogLevel, args: readonly unknown[], at = Date.now()) {
            logs.push({ at, level, args: args.map(keep) });
        },

        calls: shownCalls,
        logs: shownLogs,

        errors() {
            return {
                calls: calls.count(r => r.outcome.state === "error"),
                logs: logs.count(r => r.level === "error"),
            };
        },

        /** How many calls of each quiet method were made, kept or not */
        quiet: (): Record<string, number> => Object.fromEntries(quietCounts),

        keepsValues: keepValues,
        snapshot: keep,
    };
}
