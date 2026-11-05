/** `@aurologic/mist-api/stores`: Discord's Flux stores, typed only as far as plugins use them, and ways to follow their changes. */
import { filters, findStore, React, waitFor } from "@evi/api";

import { storeMissed } from "./start.ts";

/** Anything that announces changes the way a Flux store does, such as a plugin's own emitter */
export interface ChangeSource {
    addChangeListener(listener: () => void): void;
    removeChangeListener(listener: () => void): void;
}

export interface FluxStore extends ChangeSource { }

export interface User {
    id: string;
    username: string;
    globalName?: string | null;
    discriminator?: string;
    avatar?: string | null;
    bot?: boolean;
}

export interface UserStore extends FluxStore {
    /** Optional because Discord's store is outside our control: call it with ?.() */
    getCurrentUser?(): User | undefined;
    getUser(id: string): User | undefined;
}

export interface Channel {
    id: string;
    type: number;
    guild_id?: string | null;
    name?: string;
}

export interface ChannelStore extends FluxStore {
    getChannel(id: string): Channel | undefined;
}

export interface Guild {
    id: string;
    name: string;
}

export interface GuildStore extends FluxStore {
    getGuild(id: string): Guild | undefined;
    getGuilds(): Record<string, Guild>;
}

export interface SelectedChannelStore extends FluxStore {
    getChannelId(guildId?: string | null): string | undefined;
    getVoiceChannelId(): string | null;
}

/** Statuses per device, as in `{ desktop: "online", mobile: "idle" }`. Discord adds devices now and then. */
export type ClientStatuses = Partial<Record<string, string>>;

export interface PresenceStore extends FluxStore {
    /** Someone else's statuses per device. Discord doesn't send your own: use SessionsStore. */
    getClientStatus?(userId: string): ClientStatuses | null | undefined;
}

/** One of your own logged-in sessions. Fields aren't stable across Discord builds: check them. */
export interface Session {
    status?: unknown;
    clientInfo?: { client?: unknown; };
}

export interface SessionsStore extends FluxStore {
    getSessions?(): Record<string, Session> | null | undefined;
}

/** Saved accounts. What getUsers returns isn't stable across Discord builds: parse it. */
export interface MultiAccountStore extends FluxStore {
    getUsers(): unknown;
}

/** Streamer Mode's settings. Discord builds have shown whether it's on in each of these ways: isStreamerMode reads them all. */
export interface StreamerModeStore extends FluxStore {
    readonly enabled?: boolean;
    isEnabled?(): boolean;
    getState?(): { enabled?: boolean; } | null | undefined;
}

/** The store, or undefined while Discord hasn't made it or its webpack isn't there yet, when findStore throws */
function lookUp<T>(name: string): T | undefined {
    try {
        return findStore<T>(name);
    } catch {
        return undefined;
    }
}

/** A `stores` read: one that comes back empty during a plugin's start is a warning for that plugin */
function read<T>(name: string): T | undefined {
    const store = lookUp<T>(name);
    if (!store) storeMissed(name);
    return store;
}

/** Each store, looked up when read (undefined until Discord has it). Reading is cheap: Evi caches stores by name. */
export const stores = {
    get user() { return read<UserStore>("UserStore"); },
    get channel() { return read<ChannelStore>("ChannelStore"); },
    get guild() { return read<GuildStore>("GuildStore"); },
    get selectedChannel() { return read<SelectedChannelStore>("SelectedChannelStore"); },
    get multiAccount() { return read<MultiAccountStore>("MultiAccountStore"); },
    get presence() { return read<PresenceStore>("PresenceStore"); },
    get sessions() { return read<SessionsStore>("SessionsStore"); },
    get streamerMode() { return read<StreamerModeStore>("StreamerModeStore"); },
};

/** The logged-in account's id */
export const currentUserId = (): string | undefined => stores.user?.getCurrentUser?.()?.id;

/** Whether Streamer Mode is on. False while Discord hasn't made the store. */
export function isStreamerMode(): boolean {
    const store = stores.streamerMode;
    return store?.enabled === true || store?.isEnabled?.() === true || store?.getState?.()?.enabled === true;
}

/**
 * A change source, or a Flux store's name as Discord gives it ("PresenceStore"). A name is listened
 * to as soon as Discord makes the store, which can be after a plugin starts.
 */
export type Source = ChangeSource | string | undefined;
export type Sources = Source | readonly Source[];

function listOf(watched: Sources) {
    const list: readonly Source[] = Array.isArray(watched) ? watched : [watched];
    return list;
}

/**
 * Calls `listener` on every change of each source, for code outside React. Returns the unsubscribe,
 * which can go straight to `mist.ctx.onDispose`. A store named that Discord hasn't made yet is
 * listened to once it has, and `listener` is called then, since the store may have changed before.
 */
export function subscribe(watched: Sources, listener: () => void): () => void {
    // Its own function, so the same listener subscribed twice unsubscribes once per subscription
    const changed = () => listener();
    const undo: (() => void)[] = [];
    const listen = (source: ChangeSource) => {
        source.addChangeListener(changed);
        undo.push(() => source.removeChangeListener(changed));
    };
    for (const source of listOf(watched)) {
        if (typeof source !== "string") {
            if (source) listen(source);
            continue;
        }
        const store = lookUp<ChangeSource>(source);
        if (store) {
            listen(store);
            continue;
        }
        undo.push(waitFor<ChangeSource>(filters.byStoreName(source), late => {
            listen(late);
            listener();
        }));
    }
    return () => { for (const off of undo.splice(0)) off(); };
}

const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/**
 * `getter`'s value, kept until one of `stores` changes or one of `deps` does, like useMemo. So
 * `getter` may build a new object or array each time: the component re-renders only on a change.
 * List in `deps` whatever `getter` reads besides the stores (props, state).
 */
export function useStore<T>(watched: Sources, getter: () => T, deps: readonly unknown[] = []): T {
    const list = listOf(watched);
    const changes = React.useRef(0);
    const cache = React.useRef<{ changes: number; key: readonly unknown[]; value: T; }>(undefined);
    const listen = React.useCallback((listener: () => void) => {
        // A change between render and subscribing went unheard: the next read builds the value again
        changes.current++;
        return subscribe(list, () => {
            changes.current++;
            listener();
        });
        // The stores themselves are the dependencies, not the array holding them, which is new each render
    }, list);
    const key = [...list, ...deps];
    const read = () => {
        const kept = cache.current;
        if (kept && kept.changes === changes.current && same(kept.key, key)) return kept.value;
        const value = getter();
        cache.current = { changes: changes.current, key, value };
        return value;
    };
    return React.useSyncExternalStore(listen, read);
}
