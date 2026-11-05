/**
 * Code the CLI runs in Discord's page. Each function here and in the page functions of flux.ts,
 * store.ts and inspect.ts is sent as its source text, so it must not use anything from outside its
 * own body: no imports, no module constants, no helpers.
 */

/** How much of a value pageSnapshot keeps */
export interface Limits { string: number; items: number; keys: number; depth: number; nodes: number; }

/** What mist prints by default: enough to read an action or a store's answer in a terminal */
export const DISPLAY: Limits = { string: 200, items: 10, keys: 20, depth: 4, nodes: 300 };
/** src/values.ts's bounds for recorded values (`--full`), with a cap on objects for Discord's largest actions */
export const RECORDED: Limits = { string: 2000, items: 50, keys: 50, depth: 6, nodes: 20_000 };

/**
 * src/values.ts's snapshot for the page, with the built-in secret names only: fields and Map keys
 * named like secrets are masked, strings, lists and depth are bounded. tests/page.test.ts checks
 * that both give the same answers. `nodes` bounds the objects copied in all.
 */
export function pageSnapshot(value: unknown, limits: Limits): unknown {
    const SECRET_NAMES = /token|secret|passw|cookie|authori[sz]ation|api[-_]?key|credential|session/i;
    const TOKEN_COUNT = /tokens$/i;
    const isSecret = (key: string, field: unknown) => !(typeof field === "number" && TOKEN_COUNT.test(key)) && SECRET_NAMES.test(key);
    const seen = new Set<object>();
    let nodes = 0;

    const walk = (value: unknown, depth: number): unknown => {
        switch (typeof value) {
            case "string": return value.length > limits.string ? `${value.slice(0, limits.string)}…(+${value.length - limits.string} chars)` : value;
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
        if (depth >= limits.depth) return "[too deep]";
        if (++nodes > limits.nodes) return "…";
        if (object instanceof Error) return { error: object.name, message: object.message };
        if (object instanceof Date) return Number.isNaN(object.getTime()) ? "Invalid Date" : object.toISOString();
        if (object instanceof RegExp) return String(object);

        const named = (key: unknown, field: unknown, at: number) =>
            typeof key === "string" && isSecret(key, field) && field != null && field !== "" ? "[secret]" : walk(field, at);
        const bounded = (items: unknown[], item: (value: unknown) => unknown) => {
            const out = items.slice(0, limits.items).map(item);
            if (items.length > limits.items) out.push(`…(+${items.length - limits.items} items)`);
            return out;
        };

        seen.add(object);
        try {
            if (object instanceof Map) return bounded([...object.entries()], entry => {
                const [key, field] = entry as [unknown, unknown];
                return [walk(key, depth + 2), named(key, field, depth + 2)];
            });
            if (object instanceof Set || Array.isArray(object)) return bounded([...object], item => walk(item, depth + 1));
            const out: Record<string, unknown> = {};
            const keys = Object.keys(object);
            for (const key of keys.slice(0, limits.keys)) {
                let field: unknown;
                try { field = (object as Record<string, unknown>)[key]; } catch (err) { field = err; }
                out[key] = named(key, field, depth + 1);
            }
            if (keys.length > limits.keys) out["…"] = `+${keys.length - limits.keys} keys`;
            return out;
        } finally {
            seen.delete(object);
        }
    };
    return walk(value, 0);
}

/** An expression that calls `fn` in the page with JSON `args`, after pageSnapshot when `snapshot` is set */
export function pageExpression(fn: (...args: any[]) => unknown, args: unknown[], snapshot = false): string {
    const json = args.map(a => JSON.stringify(a) ?? "undefined");
    return `(${fn})(${[...snapshot ? [String(pageSnapshot)] : [], ...json].join(", ")})`;
}
