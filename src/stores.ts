/** `@aurologic/mist-api/stores`: Discord's Flux stores, typed only as far as plugins use them, and ways to follow their changes. */
import { type Filter, filters, find, findStore, React, waitFor } from "@evi/api";

import { checkDelay, shownValue } from "./internal.ts";
import { storeMissed } from "./start.ts";

/** Anything that announces changes the way a Flux store does, such as an emitter a plugin makes */
export interface ChangeSource {
    addChangeListener(listener: () => void): void;
    removeChangeListener(listener: () => void): void;
}

export type FluxStore = ChangeSource;

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
    /** Someone else's statuses per device. Discord doesn't send yours: use SessionsStore. */
    getClientStatus?(userId: string): ClientStatuses | null | undefined;
}

/** One of the signed-in account's sessions. Fields aren't stable across Discord builds: check them. */
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

/** A message as Discord's MessageStore holds it */
export interface Message {
    id: string;
    channel_id: string;
    content: string;
    author: User;
    type?: number;
}

/** A channel's loaded messages, oldest first */
export interface ChannelMessages {
    toArray(): Message[];
    get?(id: string): Message | undefined;
    has?(id: string): boolean;
    readonly length?: number;
}

/** Needs `readMessages` in a manifest that declares permissions, as Evi holds every message store to it */
export interface MessageStore extends FluxStore {
    getMessages(channelId: string): ChannelMessages | undefined;
    getMessage(channelId: string, messageId: string): Message | undefined;
}

export interface ReadStateStore extends FluxStore {
    hasUnread(channelId: string): boolean;
    getMentionCount(channelId: string): number;
    /** The last message read in the channel */
    ackMessageId(channelId: string): string | null | undefined;
    lastMessageId(channelId: string): string | null | undefined;
}

export interface VoiceState {
    userId: string;
    channelId: string | null;
    guildId?: string | null;
    mute?: boolean;
    deaf?: boolean;
    selfMute?: boolean;
    selfDeaf?: boolean;
    selfVideo?: boolean;
    selfStream?: boolean;
}

export interface VoiceStateStore extends FluxStore {
    getVoiceStateForUser(userId: string): VoiceState | undefined;
    /** By user id */
    getVoiceStatesForChannel(channelId: string): Record<string, VoiceState>;
    /** Whether `userId`, by default you, is in the voice channel */
    isInChannel(channelId: string, userId?: string): boolean;
}

export interface GuildMember {
    userId: string;
    guildId: string;
    nick?: string | null;
    roles: string[];
    avatar?: string | null;
}

export interface GuildMemberStore extends FluxStore {
    getMember(guildId: string, userId: string): GuildMember | null | undefined;
    getNick(guildId: string, userId: string): string | null | undefined;
    getMembers(guildId: string): GuildMember[];
}

/** Discord's RelationshipTypes: 1 friend, 2 blocked, 3 incoming request, 4 outgoing request; 0 none */
export type RelationshipType = number;

export interface RelationshipStore extends FluxStore {
    getRelationshipType(userId: string): RelationshipType;
    isFriend(userId: string): boolean;
    isBlocked(userId: string): boolean;
    getFriendIDs(): string[];
    /** The nickname you gave a friend. Optional because Discord builds before friend nicknames lack it. */
    getNickname?(userId: string): string | null | undefined;
}

/** Permission checks for you. A permission is one of Discord's bit flags, as in `1n << 11n` for Send Messages. */
export interface PermissionStore extends FluxStore {
    can(permission: bigint, context: Channel | Guild): boolean;
    canAccessGuildSettings(guild: Guild): boolean;
    computePermissions(context: Channel | Guild): bigint;
}

const isPermissionError = (err: unknown) => err instanceof Error && err.name === "PluginPermissionError";

/**
 * Discord's store by name, or undefined while Discord hasn't made it or its webpack isn't loaded. A
 * store the plugin's manifest doesn't permit, as MessageStore without `readMessages`, throws Evi's
 * PluginPermissionError instead of looking missing.
 */
export function store<T = unknown>(name: string): T | undefined {
    try {
        return findStore<T>(name);
    } catch (err) {
        if (isPermissionError(err)) throw err;
        return undefined;
    }
}

/**
 * A finder that searches Discord's webpack for `filter` until it finds something, then keeps it.
 * Undefined while there's nothing, or webpack isn't loaded. A function kept this way is the one found:
 * a hook another plugin puts on its export later doesn't run through it.
 */
export function lookup<T>(filter: Filter): () => T | undefined {
    let found: T | undefined;
    const search = () => {
        try {
            return find<T>(filter) ?? undefined;
        } catch {
            return undefined;
        }
    };
    return () => found ??= search();
}

export interface WhenStoreOptions {
    /** Rejects with the signal's reason when it aborts */
    signal?: AbortSignal;
    /** Rejects with a TimeoutError DOMException after this many ms, from 0 to 2147483647. Left out, waits as long as it takes. */
    timeout?: number;
}

const isSignal = (value: AbortSignal | WhenStoreOptions): value is AbortSignal => typeof (value as AbortSignal).aborted === "boolean";

function whenStoreOptions(signalOrOptions: AbortSignal | WhenStoreOptions | undefined): WhenStoreOptions {
    if (signalOrOptions === undefined) return {};
    if (isSignal(signalOrOptions)) return { signal: signalOrOptions };
    return signalOrOptions;
}

/**
 * Discord's store once it has made it; at once when it has. Takes a signal, or `{ signal, timeout }`.
 * Rejects with the signal's reason on abort, and with a TimeoutError DOMException once `timeout` passes.
 */
export function whenStore<T = unknown>(name: string, signalOrOptions?: AbortSignal | WhenStoreOptions): Promise<T> {
    return new Promise((resolve, reject) => {
        const { signal, timeout } = whenStoreOptions(signalOrOptions);
        if (timeout !== undefined) checkDelay("whenStore", "timeout", timeout);
        signal?.throwIfAborted();
        const now = store<T>(name);
        if (now) return resolve(now);
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };
        const giveUp = (reason: unknown) => {
            finish();
            stop();
            reject(reason);
        };
        const onAbort = () => giveUp(signal!.reason);
        const stop = waitFor<T>(filters.byStoreName(name), late => {
            if (settled) return;
            finish();
            resolve(late);
        });
        if (settled) return;
        signal?.addEventListener("abort", onAbort, { once: true });
        if (timeout !== undefined) timer = setTimeout(() => giveUp(new DOMException(`whenStore: timed out waiting for ${shownValue(name)}`, "TimeoutError")), timeout);
    });
}

/** A `stores` read: one that comes back empty during a plugin's start is a warning for that plugin */
function read<T>(name: string): T | undefined {
    const found = store<T>(name);
    if (!found) storeMissed(name);
    return found;
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
    /** Throws PluginPermissionError for a plugin whose manifest declares permissions without `readMessages` */
    get messages() { return read<MessageStore>("MessageStore"); },
    get readStates() { return read<ReadStateStore>("ReadStateStore"); },
    get voiceStates() { return read<VoiceStateStore>("VoiceStateStore"); },
    get guildMembers() { return read<GuildMemberStore>("GuildMemberStore"); },
    get relationships() { return read<RelationshipStore>("RelationshipStore"); },
    get permissions() { return read<PermissionStore>("PermissionStore"); },
};

/** The logged-in account's id */
export const currentUserId = (): string | undefined => stores.user?.getCurrentUser?.()?.id;

/** Whether Streamer Mode is on. False while Discord hasn't made the store. */
export function isStreamerMode(): boolean {
    const mode = stores.streamerMode;
    return mode?.enabled === true || mode?.isEnabled?.() === true || mode?.getState?.()?.enabled === true;
}

/**
 * A change source, or a Flux store's name as Discord gives it ("PresenceStore"). A name is listened
 * to as soon as Discord makes the store, which can be after a plugin starts.
 */
export type Source = ChangeSource | string | undefined;
export type Sources = Source | readonly Source[];

const listOf = (watched: Sources): readonly Source[] => [watched].flat();

/**
 * Calls `listener` on every change of each source, for code outside React. Returns the unsubscribe,
 * which can go straight to `mist.ctx.onDispose`. A store named that Discord hasn't made yet is
 * listened to once it has, and `listener` is called then, as the store may have changed before. A
 * source that throws when subscribed to unsubscribes the ones before it, then the error is thrown.
 */
export function subscribe(watched: Sources, listener: () => void): () => void {
    // A wrapper per call: the same listener subscribed twice unsubscribes once per subscription
    const changed = () => listener();
    const undo: (() => void)[] = [];
    const unsubscribe = () => { for (const off of undo.splice(0)) off(); };
    const listen = (source: ChangeSource) => {
        source.addChangeListener(changed);
        undo.push(() => source.removeChangeListener(changed));
    };
    try {
        for (const source of listOf(watched)) {
            if (typeof source !== "string") {
                if (source) listen(source);
                continue;
            }
            const named = store<ChangeSource>(source);
            if (named) {
                listen(named);
                continue;
            }
            undo.push(waitFor<ChangeSource>(filters.byStoreName(source), late => {
                listen(late);
                listener();
            }));
        }
    } catch (err) {
        unsubscribe();
        throw err;
    }
    return unsubscribe;
}

const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/**
 * `getter`'s value, kept until one of `stores` changes or one of `deps` does, like useMemo. So
 * `getter` may build a new object or array each time: the component re-renders only on a change.
 * List in `deps` whatever `getter` reads besides the stores (props, state).
 */
export function useStore<T>(watched: Sources, getter: () => T, deps: readonly unknown[] = []): T {
    // The array passed is new each render: the one kept changes only when the sources in it do.
    // State set during render, React's pattern for state derived from props, not a ref written while rendering.
    const given = listOf(watched);
    const [list, setList] = React.useState(given);
    if (!same(list, given)) setList(given);
    const changes = React.useRef(0);
    const cache = React.useRef<{ changes: number; key: readonly unknown[]; value: T; }>(undefined);
    const listen = React.useCallback((listener: () => void) => {
        // A change between render and subscribing went unheard: the next read builds the value again
        changes.current++;
        return subscribe(list, () => {
            changes.current++;
            listener();
        });
    }, [list]);
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
