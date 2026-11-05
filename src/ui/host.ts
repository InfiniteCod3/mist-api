import { React } from "@evi/api";
import type { ComponentType } from "react";

import { Boundary, type Fallback } from "./boundary.ts";
import { notify, type Owner, owned, shared } from "./shared.ts";

interface Shown<P> {
    readonly Component: ComponentType<P>;
    readonly owner: ReturnType<typeof owned>;
    readonly fallback: Fallback | undefined;
}

/** On globalThis per name: what the host shows now, and the one host component every copy hands out */
interface HostState<P> {
    readonly protocol: 1;
    readonly listeners: Set<() => void>;
    current: Shown<P> | undefined;
    readonly Host: ComponentType<P>;
}

export interface HostOptions {
    /** Shown if the component throws; defaults to Boundary's notice */
    fallback?: Fallback;
}

export interface Host<P> {
    /**
     * The same component in every copy of mist-api and after every hot reload. It renders what the
     * running plugin set, inside a Boundary, and nothing while the plugin is stopped.
     */
    readonly Component: ComponentType<P>;
    /** Shows `Component` in the host until the plugin stops or the returned function runs */
    set(owner: Owner, Component: ComponentType<P>, options?: HostOptions): () => void;
}

/**
 * A stable mount point for a plugin's UI. Discord keeps whatever component a patch handed it, so a
 * component from the plugin's code would be the stopped copy's after a hot reload. Mount `Component`
 * instead and `set` the real one on each start. `name` is the protocol between copies: prefix it
 * with the plugin's id and change it when the props change.
 */
export function host<P extends object = {}>(name: string): Host<P> {
    if (!name) throw new Error("mist ui: a host needs a name");
    const state = shared<HostState<P>>(`host/${name}`, () => {
        const made: Omit<HostState<P>, "Host"> = { protocol: 1, listeners: new Set(), current: undefined };
        const listen = (listener: () => void) => {
            made.listeners.add(listener);
            return () => void made.listeners.delete(listener);
        };
        const read = () => made.current;
        function MistHost(props: P) {
            const shown = React.useSyncExternalStore(listen, read);
            if (!shown) return null;
            return React.createElement(Boundary, { name: `${shown.owner.id}'s ${name}`, mist: shown.owner, fallback: shown.fallback },
                React.createElement(shown.Component, props));
        }
        MistHost.displayName = `MistHost(${name})`;
        return Object.assign(made, { Host: MistHost });
    }, s => s.listeners instanceof Set && typeof s.Host === "function");

    return {
        Component: state.Host,
        set(owner, Component, options = {}) {
            const by = owned(owner);
            const shown: Shown<P> = { Component, owner: by, fallback: options.fallback };
            state.current = shown;
            notify(state.listeners);
            const release = () => {
                if (state.current !== shown) return;
                state.current = undefined;
                notify(state.listeners);
            };
            by.onDispose(release);
            return release;
        },
    };
}
