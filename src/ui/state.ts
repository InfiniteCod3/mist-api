import { React } from "@evi/api";

import type { ChangeSource } from "../stores.ts";
import { notify } from "./shared.ts";

/** A value that announces its changes like a Flux store: `useStore` and `subscribe` take it too */
export interface Readable<T> extends ChangeSource {
    get(): T;
}

/** An observable value, shaped like `mist.data`: get, set, update, use and onChange */
export interface State<T> extends Readable<T> {
    /** Notifies listeners, unless `value` is the current value (Object.is) */
    set(value: T): void;
    update(fn: (current: T) => T): void;
    /** React hook: the value, re-rendering when it changes. The same as `useValue(state)`. */
    use(): T;
    /** Calls `listener` with the value whenever it changes, until the returned function is called */
    onChange(listener: (value: T) => void): () => void;
}

/** One observable value, for state a plugin's UI and its other code share */
export function state<T>(initial: T): State<T> {
    let current = initial;
    const listeners = new Set<() => void>();
    const set = (value: T) => {
        if (Object.is(value, current)) return;
        current = value;
        notify("state", listeners);
    };
    const self: State<T> = {
        get: () => current,
        set,
        update: fn => set(fn(current)),
        use: () => useValue(self),
        onChange(listener) {
            const heard = () => listener(current);
            listeners.add(heard);
            return () => void listeners.delete(heard);
        },
        addChangeListener: listener => void listeners.add(listener),
        removeChangeListener: listener => void listeners.delete(listener),
    };
    return self;
}

/** The value of `source`, cached between changes so sources whose `get()` returns a fresh copy still work */
export function useValue<T>(source: Readable<T>): T {
    const changes = React.useRef(0);
    const cache = React.useRef<{ source: Readable<T>; changes: number; value: T; }>(undefined);
    const listen = React.useCallback((listener: () => void) => {
        // A change between render and subscribing went unheard: the next read fetches the value again
        changes.current++;
        const changed = () => {
            changes.current++;
            listener();
        };
        source.addChangeListener(changed);
        return () => source.removeChangeListener(changed);
    }, [source]);
    const read = React.useCallback(() => {
        const kept = cache.current;
        if (kept && kept.source === source && kept.changes === changes.current) return kept.value;
        const value = source.get();
        cache.current = { source, changes: changes.current, value };
        return value;
    }, [source]);
    return React.useSyncExternalStore(listen, read);
}
