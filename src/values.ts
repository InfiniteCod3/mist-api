/**
 * A recorded value is copied once, when it's recorded, into a bounded JSON-safe Snapshot, so later
 * mutation doesn't change history and it crosses CDP and Electron IPC as is.
 */
export type Snapshot = null | boolean | number | string | Snapshot[] | { [key: string]: Snapshot; };

declare const reduced: unique symbol;
/** A value reduced to its type and size, as in `"string(12)"`: nothing it contained is left */
export type Reduced = string & { readonly [reduced]: true; };

const MAX_STRING = 2000;
const MAX_ITEMS = 50;
const MAX_KEYS = 50;
const MAX_DEPTH = 6;

export const MASKED = "[secret]";
const SECRET_NAMES = /token|secret|passw|cookie|authori[sz]ation|api[-_]?key|credential|session/i;

/** A count of tokens, as in input_tokens or maxTokens, rather than a token */
const TOKEN_COUNT = /tokens$/i;

export type SecretTest = (key: string, value: unknown) => boolean;

/**
 * Whether a field or Map entry holds a secret: one of the plugin's own `secrets`, or a built-in name
 * the plugin didn't `reveal`, other than a token count
 */
export function secretTest(secrets: readonly string[] = [], reveal: readonly string[] = []): SecretTest {
    const own = new Set(secrets.map(n => n.toLowerCase()));
    const shown = new Set(reveal.map(n => n.toLowerCase()));
    return (key, value) => {
        const name = key.toLowerCase();
        if (own.has(name)) return true;
        if (shown.has(name) || typeof value === "number" && TOKEN_COUNT.test(key)) return false;
        return SECRET_NAMES.test(key);
    };
}

export function snapshot(value: unknown, isSecret: SecretTest = secretTest(), depth = 0, seen = new Set<object>()): Snapshot {
    switch (typeof value) {
        case "string": return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING} chars)` : value;
        case "number": return Number.isFinite(value) ? value : String(value);
        case "boolean": return value;
        case "undefined": return null;
        case "bigint": return `${value}n`;
        case "symbol": return value.toString();
        case "function": return `[function ${value.name || "anonymous"}]`;
    }
    if (value === null) return null;
    const object = value as object;
    if (seen.has(object)) return "[circular]";
    if (depth >= MAX_DEPTH) return "[too deep]";
    if (object instanceof Error) return { error: object.name, message: object.message };
    if (object instanceof Date) return Number.isNaN(object.getTime()) ? "Invalid Date" : object.toISOString();
    if (object instanceof RegExp) return String(object);

    const named = (key: unknown, value: unknown, at = depth + 1): Snapshot =>
        typeof key === "string" && isSecret(key, value) && value != null && value !== "" ? MASKED : snapshot(value, isSecret, at, seen);
    const bounded = (items: unknown[], item: (value: unknown) => Snapshot): Snapshot[] => {
        const out = items.slice(0, MAX_ITEMS).map(item);
        if (items.length > MAX_ITEMS) out.push(`…(+${items.length - MAX_ITEMS} items)`);
        return out;
    };

    seen.add(object);
    try {
        if (object instanceof Map) return bounded([...object.entries()], entry => {
            const [key, value] = entry as [unknown, unknown];
            return [snapshot(key, isSecret, depth + 2, seen), named(key, value, depth + 2)];
        });
        if (object instanceof Set || Array.isArray(object)) return bounded([...object], item => snapshot(item, isSecret, depth + 1, seen));
        const out: { [key: string]: Snapshot; } = {};
        const keys = Object.keys(object);
        for (const key of keys.slice(0, MAX_KEYS)) {
            let field: unknown;
            try { field = (object as Record<string, unknown>)[key]; } catch (err) { field = err; }
            out[key] = named(key, field);
        }
        if (keys.length > MAX_KEYS) out["…"] = `+${keys.length - MAX_KEYS} keys`;
        return out;
    } finally {
        seen.delete(object);
    }
}

/** The redacted view of a snapshot: its type and size, nothing it contains */
export function describe(value: Snapshot): Reduced {
    if (value === null) return "null" as Reduced;
    if (Array.isArray(value)) return `array(${value.length})` as Reduced;
    if (typeof value === "object") return `object(${Object.keys(value).length} keys)` as Reduced;
    if (typeof value === "string") return `string(${value.length})` as Reduced;
    return typeof value as Reduced;
}
