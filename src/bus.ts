/**
 * `@aurologic/mist-api/bus`: channels and slots between plugins. Their data lives on globalThis under a Symbol.for
 * key per name and version, so every bundled copy shares it; change the version when the payload changes.
 */

/** Data shared on globalThis. Its shape is the bus's own protocol (BUS_PROTOCOL), not mist-api's version. */
interface Shared {
    readonly protocol: 1;
    readonly listeners: Set<(value: unknown) => void>;
    /** A fresh box per set, so a release clears only the value it set */
    current?: { value: unknown; };
}

const BUS_PROTOCOL = 1;

function shared(kind: "channel" | "slot", name: string, version: number, root: object): Shared {
    if (!name || !Number.isInteger(version) || version < 1) throw new Error(`mist bus: bad name or version (${name}@${version})`);
    // A protocol name like the registry key, not the package name
    const key = Symbol.for(`mist-api.bus/${kind}/${name}@${version}`);
    const target = root as Record<symbol, unknown>;
    const existing = target[key] as Shared | undefined;
    if (existing) {
        if (existing.protocol !== BUS_PROTOCOL || !(existing.listeners instanceof Set)) throw new Error(`mist bus: ${kind} ${name}@${version} was made by an incompatible copy`);
        return existing;
    }
    const created: Shared = { protocol: BUS_PROTOCOL, listeners: new Set() };
    Object.defineProperty(target, key, { value: created, configurable: false, enumerable: false, writable: false });
    return created;
}

function notify(state: Shared, value: unknown) {
    for (const listener of [...state.listeners]) {
        // One listener must not break another or the sender. Nothing is printed: values may be private.
        try { listener(value); } catch { }
    }
}

function listen<T>(state: Shared, listener: (value: T) => void): () => void {
    const fn = listener as (value: unknown) => void;
    state.listeners.add(fn);
    return () => void state.listeners.delete(fn);
}

export interface Channel<T> {
    /** Delivers `value` to every current subscriber, in every copy. Nothing is kept. */
    publish(value: T): void;
    subscribe(listener: (value: T) => void): () => void;
}

/** Events between plugins: whoever subscribed before a publish gets it */
export function channel<T>(name: string, version: number, root: object = globalThis): Channel<T> {
    const state = shared("channel", name, version, root);
    return {
        publish: value => notify(state, value),
        subscribe: listener => listen(state, listener),
    };
}

export interface Slot<T> {
    get(): T | undefined;
    /** Holds `value` until the returned release runs; release only clears it if it's still this value */
    set(value: T): () => void;
    /** Called with the new value, or undefined once released */
    subscribe(listener: (value: T | undefined) => void): () => void;
}

/** One shared value, like a running plugin offering an API to others: set on start, released on stop */
export function slot<T>(name: string, version: number, root: object = globalThis): Slot<T> {
    const state = shared("slot", name, version, root);
    return {
        get: () => state.current?.value as T | undefined,
        set(value) {
            const box = { value };
            state.current = box;
            notify(state, value);
            return () => {
                if (state.current !== box) return;
                state.current = undefined;
                notify(state, undefined);
            };
        },
        subscribe: listener => listen(state, listener),
    };
}
