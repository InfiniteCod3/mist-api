import { React } from "@evi/api";

import type { ChangeSource } from "../stores.ts";

/** A value that announces its changes like a Flux store, so `useStore` and `subscribe` take it too */
export interface Readable<T> extends ChangeSource {
    get(): T;
}

export interface State<T> extends Readable<T> {
    /** Notifies listeners, unless `value` is the current value (Object.is) */
    set(value: T): void;
    update(fn: (current: T) => T): void;
}

/** One observable value, for state a plugin's UI and its other code share */
export function state<T>(initial: T): State<T> {
    let current = initial;
    const listeners = new Set<() => void>();
    const set = (value: T) => {
        if (Object.is(value, current)) return;
        current = value;
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch (err) {
                console.error("mist state: a listener threw", err);
            }
        }
    };
    return {
        get: () => current,
        set,
        update: fn => set(fn(current)),
        addChangeListener: listener => void listeners.add(listener),
        removeChangeListener: listener => void listeners.delete(listener),
    };
}

/** The value of `source`, re-rendering on each change */
export function useValue<T>(source: Readable<T>): T {
    const listen = React.useCallback((listener: () => void) => {
        source.addChangeListener(listener);
        return () => source.removeChangeListener(listener);
    }, [source]);
    const read = React.useCallback(() => source.get(), [source]);
    return React.useSyncExternalStore(listen, read);
}
