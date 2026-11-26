/** Helpers shared across mist-api's modules. Not exported from any subpath. */

export type Method = (...args: any[]) => unknown;

/** The error's message, or its text. Never throws, even for a value whose toString does. */
export function errorMessage(err: unknown): string {
    try {
        return err instanceof Error ? err.message : String(err);
    } catch {
        return Object.prototype.toString.call(err);
    }
}

/** Runs `fn` now, turning a synchronous throw into a rejection */
export function begin<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
        return Promise.resolve(fn());
    } catch (err) {
        return Promise.reject(err);
    }
}

export type Attempt<T> = { ok: true; value: T; } | { ok: false; error: string; };

export function attempt<T>(fn: () => T): Attempt<T> {
    try {
        return { ok: true, value: fn() };
    } catch (err) {
        return { ok: false, error: errorMessage(err) };
    }
}

export async function attemptAsync<T>(fn: () => T | Promise<T>): Promise<Attempt<T>> {
    try {
        return { ok: true, value: await fn() };
    } catch (err) {
        return { ok: false, error: errorMessage(err) };
    }
}

export function unwrapAttempt<T>(result: Attempt<T>): T | { error: string; };
export function unwrapAttempt<T, R>(result: Attempt<T>, show: (value: T) => R): R | { error: string; };
export function unwrapAttempt<T, R>(result: Attempt<T>, show?: (value: T) => R): T | R | { error: string; } {
    if (!result.ok) return { error: result.error };
    return show ? show(result.value) : result.value;
}

/**
 * Evi's errors for a plugin without a native module and for a module without the method (Electron
 * prefixes the second). Either holds for the whole run.
 */
export const lacksNative = (err: unknown) => /\bno native (?:module|method)\b/.test(errorMessage(err));

/** A logger that writes each distinct line and error message once. `err` is passed on only when given. */
export type LogOnce = (line: string, ...err: [err?: unknown]) => void;

/**
 * Logs each of the first `cap` distinct line and error message pairs once, then one notice that the
 * rest are suppressed. `label` starts the notice, as in "mist.safe".
 */
export function createLogOnce(write: LogOnce, label?: string, cap = 50): LogOnce {
    const seen = new Set<string>();
    let full = false;
    return (line, ...err) => {
        const key = err.length ? `${line}\n${errorMessage(err[0])}` : line;
        if (seen.has(key)) return;
        if (seen.size >= cap) {
            if (full) return;
            full = true;
            write(`${label ? `${label}: ` : ""}${cap} distinct errors logged; further errors suppressed`);
            return;
        }
        seen.add(key);
        write(line, ...err);
    };
}

/** Calls each listener with `args`. One that throws goes to `onError` and doesn't keep the others from hearing. */
export function notifyEach<A extends unknown[]>(listeners: Iterable<(...args: A) => void>, args: A, onError: (fn: (...args: A) => void, err: unknown) => void): void {
    for (const fn of [...listeners]) {
        try {
            fn(...args);
        } catch (err) {
            try { onError(fn, err); } catch { }
        }
    }
}

export const stoppedMessage = (pluginId: string) => `${pluginId}'s native side stopped`;

/** The reason a plugin's calls and waits reject with once its native side stops */
export const stoppedError = (pluginId: string) => new DOMException(stoppedMessage(pluginId), "AbortError");

/** The longest delay setTimeout takes: a longer one overflows 32 bits and fires at once */
export const MAX_TIMEOUT_MS = 2_147_483_647;

export interface NumberRule {
    min?: number;
    max?: number;
    /** `min` itself is out of range */
    exclusiveMin?: boolean;
    integer?: boolean;
}

function describeRule({ min, max, exclusiveMin, integer }: NumberRule) {
    const kind = integer ? "a whole number" : "a finite number";
    const from = min === undefined ? "" : ` ${exclusiveMin ? "above" : "from"} ${min}`;
    const to = max === undefined ? "" : `${min === undefined ? " up" : ""} to ${max}`;
    return kind + from + to;
}

/**
 * Returns `value` when it is a number that keeps `rule`. Throws a TypeError, starting with `fn`, for
 * anything else or NaN, and a RangeError for a number out of range, infinite, or not whole when it must be.
 */
export function checkNumber(fn: string, name: string, value: unknown, rule: NumberRule = {}): number {
    if (typeof value !== "number" || Number.isNaN(value)) throw new TypeError(`${fn}: ${name} must be a number, got ${shownValue(value)}`);
    const { min, max, exclusiveMin, integer } = rule;
    const low = min !== undefined && (exclusiveMin ? value <= min : value < min);
    if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || low || (max !== undefined && value > max)) {
        throw new RangeError(`${fn}: ${name} must be ${describeRule(rule)}, got ${value}`);
    }
    return value;
}

/** `checkNumber` for a delay setTimeout can hold: from 0 to MAX_TIMEOUT_MS */
export const checkDelay = (fn: string, name: string, value: unknown) => checkNumber(fn, name, value, { min: 0, max: MAX_TIMEOUT_MS });

/** `checkNumber` for a positive timeout or interval setTimeout/setInterval can hold: above 0 to MAX_TIMEOUT_MS */
export const checkTimeout = (fn: string, name: string, value: unknown) => checkNumber(fn, name, value, { min: 0, exclusiveMin: true, max: MAX_TIMEOUT_MS });

/** A value as an error message shows it: strings quoted, objects by type. Never throws. */
export function shownValue(value: unknown): string {
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "symbol") return value.toString();
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return String(value);
    if (Array.isArray(value)) return "an array";
    return typeof value === "function" ? "a function" : "an object";
}

/** `value` as JSON text, or a TypeError naming `what` for anything JSON can't hold */
export function jsonText(what: string, value: unknown): string {
    let json: string | undefined;
    try {
        json = JSON.stringify(value);
    } catch (err) {
        throw new TypeError(`${what} can't be stored as JSON (${errorMessage(err)})`);
    }
    if (json === undefined) throw new TypeError(`${what} can't be stored as JSON (got ${shownValue(value)})`);
    return json;
}

/** Whether `value` is a Promise or any other thenable, even from another realm */
export const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown; }).then === "function";

/**
 * The value under `key` on `target` (globalThis by default), which every bundled copy of mist-api
 * shares. The first copy puts `make()` there, not configurable or writable, so page code can't swap
 * it. Throws a TypeError, naming `label`, when something there fails `valid`.
 */
export function globalSlot<T>(key: symbol, make: () => T, valid: (value: unknown) => value is T, label: string, target: object = globalThis): T {
    const root = target as Record<symbol, unknown>;
    const existing = root[key];
    if (existing !== undefined) {
        if (valid(existing)) return existing;
        throw new TypeError(`${label} was made by an incompatible copy of mist-api`);
    }
    const created = make();
    Object.defineProperty(root, key, { value: created, configurable: false, enumerable: false, writable: false });
    return created;
}

interface Disposable { onDispose(fn: () => void): unknown; }

interface Scope { ended: boolean; fns: Set<() => void>; }

const scopes = new WeakMap<Disposable, Scope>();

/**
 * Runs `fn` when `owner` (a plugin run) is disposed, like its onDispose, but returns a function that
 * takes `fn` back out: subscriptions that end early don't pile up in the run's disposers.
 */
export function onEnd(owner: Disposable, fn: () => void): () => void {
    let scope = scopes.get(owner);
    if (!scope) {
        const created: Scope = scope = { ended: false, fns: new Set() };
        scopes.set(owner, created);
        owner.onDispose(() => {
            created.ended = true;
            for (const end of [...created.fns]) end();
            created.fns.clear();
        });
    }
    if (scope.ended) {
        fn();
        return () => { };
    }
    const fns = scope.fns;
    fns.add(fn);
    return () => void fns.delete(fn);
}
