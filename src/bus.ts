/**
 * `@aurologic/mist-api/bus`: channels and slots between plugins. Their data lives on globalThis under a Symbol.for
 * key per name and version, which every bundled copy shares; change the version when the payload changes.
 */
import { checkNumber, globalSlot, notifyEach, shownValue } from "./internal.ts";

/** Data shared on globalThis. Its shape is the bus's protocol (BUS_PROTOCOL), not mist-api's version. */
interface Shared {
    readonly protocol: 1;
    readonly listeners: Set<(value: unknown) => void>;
    /** A fresh box per set: a release clears only the value it set */
    current?: { value: unknown; };
}

const BUS_PROTOCOL = 1;

const isShared = (value: unknown): value is Shared =>
    typeof value === "object" && value !== null && (value as Shared).protocol === BUS_PROTOCOL && (value as Shared).listeners instanceof Set;

function shared(kind: "channel" | "slot", name: string, version: number, root: object): { state: Shared; label: string; } {
    if (typeof name !== "string" || !name) throw new TypeError(`${kind}: name must be a non-empty string, got ${shownValue(name)}`);
    checkNumber(kind, "version", version, { min: 1, integer: true });
    const label = `${kind} ${name}@${version}`;
    const key = Symbol.for(`mist-api.bus/${kind}/${name}@${version}`);
    const state = globalSlot(key, (): Shared => ({ protocol: BUS_PROTOCOL, listeners: new Set() }), isShared, label, root);
    return { state, label };
}

/** One listener must not break another or the sender. The value isn't printed: it may be private. */
function notify(label: string, state: Shared, value: unknown) {
    notifyEach(state.listeners, [value], (listener, err) => console.error(`${label}: a listener (${listener.name || "anonymous"}) threw`, err));
}

function listen<T>(state: Shared, listener: (value: T) => void): () => void {
    const fn = listener as (value: unknown) => void;
    state.listeners.add(fn);
    return () => void state.listeners.delete(fn);
}

export interface BusChannel<T> {
    /** Delivers `value` to every current subscriber, in every copy. Nothing is kept. */
    publish(value: T): void;
    subscribe(listener: (value: T) => void): () => void;
}

/** Events between plugins: whoever subscribed before a publish gets it */
export function channel<T>(name: string, version: number, root: object = globalThis): BusChannel<T> {
    const { state, label } = shared("channel", name, version, root);
    return {
        publish: value => notify(label, state, value),
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
    const { state, label } = shared("slot", name, version, root);
    return {
        get: () => state.current?.value as T | undefined,
        set(value) {
            const box = { value };
            state.current = box;
            notify(label, state, value);
            return () => {
                if (state.current !== box) return;
                state.current = undefined;
                notify(label, state, undefined);
            };
        },
        subscribe: listener => listen(state, listener),
    };
}
