/** Guards for the arguments a native method gets from the page, which nothing checks across IPC. */
import { NativeError } from "./errors.ts";
import { shownValue } from "./internal.ts";
import { isRecord, isSnowflake } from "./util.ts";

/** What `check` throws for an argument it refuses: `data.name` is the argument, `data.expected` what it had to be */
export interface BadArgument {
    name: string;
    expected: string;
}

function refuse(name: string, expected: string): never {
    throw new NativeError<BadArgument>("bad-argument", { name, expected }, `${name} must be ${expected}`);
}

export interface TextOptions {
    max: number;
    /** Default 0 */
    min?: number;
    /** The argument's name in the error. Default "value" */
    name?: string;
}

export interface IntOptions {
    min: number;
    max: number;
    name?: string;
}

export interface HttpsOptions {
    /** Hosts the URL may have: "example.com" is that host only, "*.example.com" any host under it. Default any host */
    hosts?: readonly string[];
    name?: string;
}

export interface ListOptions {
    max: number;
    name?: string;
}

/** The longest URL `check.https` takes */
const MAX_URL = 8192;

const hostAllowed = (host: string, hosts: readonly string[]) => hosts.some(allowed => {
    const pattern = allowed.toLowerCase();
    return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern;
});

/**
 * Each guard returns the value, typed, or throws a NativeError "bad-argument" with `{ name, expected }`,
 * which the page's call rejects with as a MistNativeError.
 */
export const check = {
    text(value: unknown, { max, min = 0, name = "value" }: TextOptions): string {
        if (typeof value !== "string" || value.length < min || value.length > max) refuse(name, min > 0 ? `a string of ${min} to ${max} characters` : `a string of at most ${max} characters`);
        return value;
    },

    /** A Discord id: a string of 1 to 20 digits */
    id(value: unknown, name = "value"): string {
        if (!isSnowflake(value)) refuse(name, "a Discord id");
        return value;
    },

    /** A whole number from `min` to `max` */
    int(value: unknown, { min, max, name = "value" }: IntOptions): number {
        if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) refuse(name, `a whole number from ${min} to ${max}`);
        return value as number;
    },

    bool(value: unknown, name = "value"): boolean {
        if (typeof value !== "boolean") refuse(name, "true or false");
        return value;
    },

    /** One of `list`, compared with === */
    oneOf<const T>(value: unknown, list: readonly T[], name = "value"): T {
        if (!list.includes(value as T)) refuse(name, `one of ${list.map(shownValue).join(", ")}`);
        return value as T;
    },

    /** An https URL without a user name or password, on one of `hosts` when given. Returns it parsed. */
    https(value: unknown, { hosts, name = "value" }: HttpsOptions = {}): URL {
        const expected = hosts ? `an https URL on ${hosts.join(", ")}` : "an https URL";
        const url = typeof value === "string" && value.length <= MAX_URL ? URL.parse(value) : null;
        if (!url || url.protocol !== "https:" || url.username || url.password || (hosts && !hostAllowed(url.hostname, hosts))) refuse(name, expected);
        return url;
    },

    /** An array of at most `max` items, each checked by `item`, which gets the item's name as `name[i]` */
    list<T>(value: unknown, item: (value: unknown, name: string) => T, { max, name = "value" }: ListOptions): T[] {
        if (!Array.isArray(value) || value.length > max) refuse(name, `a list of at most ${max} items`);
        return value.map((each, i) => item(each, `${name}[${i}]`));
    },

    /** An object that isn't null or an array, to read fields from */
    record(value: unknown, name = "value"): Record<string, unknown> {
        if (!isRecord(value)) refuse(name, "an object");
        return value;
    },
};
