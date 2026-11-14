export interface TtlCacheOptions<V> {
    /** How long an entry lives, in ms: one number, or a function of the value set. 0 or less keeps nothing, Infinity keeps it until it's evicted. */
    ttlMs: number | ((value: V) => number);
    /** The most entries kept. Setting one more evicts the one read or set longest ago. Default no cap */
    max?: number;
    /** The clock. Default Date.now */
    now?: () => number;
}

export interface TtlCache<K, V> {
    /** The value, unless it is missing or expired. A hit counts as a use for `max`. */
    get(key: K): V | undefined;
    set(key: K, value: V): void;
    has(key: K): boolean;
    /** True when there was a live entry */
    delete(key: K): boolean;
    clear(): void;
    /** How many live entries there are */
    readonly size: number;
}

/** A Map whose entries expire after `ttlMs`, with an optional cap that evicts the least recently used. Expired entries are dropped as they are found. */
export function ttlCache<K, V>({ ttlMs, max = Infinity, now = Date.now }: TtlCacheOptions<V>): TtlCache<K, V> {
    if (typeof ttlMs !== "function" && (typeof ttlMs !== "number" || Number.isNaN(ttlMs))) throw new TypeError(`ttlCache's ttlMs must be a number or a function, got ${ttlMs}`);
    if (max !== Infinity && !(Number.isInteger(max) && max > 0)) throw new TypeError(`ttlCache's max must be a whole number above 0, got ${max}`);
    const entries = new Map<K, { value: V; until: number; }>();
    const live = (key: K) => {
        const entry = entries.get(key);
        if (!entry) return undefined;
        if (entry.until > now()) return entry;
        entries.delete(key);
        return undefined;
    };
    return {
        get(key) {
            const entry = live(key);
            if (!entry) return undefined;
            entries.delete(key);
            entries.set(key, entry);
            return entry.value;
        },
        set(key, value) {
            entries.delete(key);
            const ttl = typeof ttlMs === "function" ? ttlMs(value) : ttlMs;
            if (!(ttl > 0)) return;
            entries.set(key, { value, until: now() + ttl });
            for (const oldest of entries.keys()) {
                if (entries.size <= max) break;
                entries.delete(oldest);
            }
        },
        has: key => live(key) !== undefined,
        delete: key => live(key) !== undefined && entries.delete(key),
        clear: () => entries.clear(),
        get size() {
            const at = now();
            for (const [key, entry] of entries) if (entry.until <= at) entries.delete(key);
            return entries.size;
        },
    };
}
