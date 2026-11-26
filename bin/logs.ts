/** mist logs, calls and native-logs: what a plugin's recorder kept, read through its debug capability */
import { callCapability, type Send, sleep } from "./cdp.ts";
import { clip, time } from "./format.ts";

export interface LogRecord { at: number; level: string; args: unknown[]; }
type Outcome = { state: "pending"; } | { state: "ok"; ms: number; result: unknown; } | { state: "error"; ms: number; message: unknown; };
export interface CallRecord { method: string; at: number; args: unknown[]; outcome: Outcome; }

const show = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);

export const logLine = (record: LogRecord) => `${time(record.at)} ${record.level.padEnd(5)} ${record.args.map(show).join(" ")}`;

export function callLine(call: CallRecord): string {
    const head = `${time(call.at)} ${call.method}(${clip(call.args.map(arg => JSON.stringify(arg)).join(", "))})`;
    switch (call.outcome.state) {
        case "pending": return `${head} … pending`;
        case "ok": return `${head} ok ${Math.round(call.outcome.ms)} ms -> ${clip(JSON.stringify(call.outcome.result) ?? "undefined")}`;
        case "error": return `${head} failed ${Math.round(call.outcome.ms)} ms: ${show(call.outcome.message)}`;
    }
}

export const readLogs = (send: Send, plugin: string, count: number) =>
    callCapability<LogRecord[]>(send, plugin, "function (n) { return this.logs(n); }", [count]);

/**
 * The records of `next` that came after `previous`, two reads of the newest `count` records. The
 * longest run that ends `previous` and starts `next` is what both reads saw: two identical lines
 * logged in the same millisecond still count as two. `dropped` says more than `count` came between
 * the reads and some were never seen.
 */
export function freshRecords(previous: string[], next: string[], count: number): { fresh: number; dropped: boolean; } {
    for (let k = Math.min(previous.length, next.length); k > 0; k--) {
        if (next.slice(0, k).every((key, i) => key === previous[previous.length - k + i])) return { fresh: next.length - k, dropped: false };
    }
    return { fresh: next.length, dropped: previous.length > 0 && next.length >= count };
}

/** Prints the plugin's newest `count` log lines, then each new one, until the process is stopped */
export async function followLogs(send: Send, plugin: string, count: number, pollMs = 1000): Promise<never> {
    let previous: string[] = [];
    for (; ;) {
        const records = await readLogs(send, plugin, count);
        const keys = records.map(record => JSON.stringify(record));
        const { fresh, dropped } = freshRecords(previous, keys, count);
        if (dropped) console.error(`… more than ${count} lines came between two reads and some aren't shown (-n reads more)`);
        for (const record of records.slice(records.length - fresh)) console.log(logLine(record));
        previous = keys;
        await sleep(pollMs);
    }
}
