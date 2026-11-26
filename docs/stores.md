# Stores

`@aurologic/mist-api/stores` types the Discord Flux stores that plugins use. It gives a React hook that re-renders when they change, a listener for code outside React, and lookups that don't throw while Discord is still loading. It runs on the page side only: it imports `findStore`, `find`, and `React` from `@evi/api`.

```ts
import { type ChangeSource, currentUserId, type FluxStore, isStreamerMode, lookup, type Source, type Sources, store, stores, subscribe, useStore, whenStore } from "@aurologic/mist-api/stores";
```

The store interfaces are minimal. Each lists only the methods plugins call. A store method that isn't listed still exists at runtime, and a plugin can extend the interface to use it.

## ChangeSource and FluxStore

```ts
interface ChangeSource {
	addChangeListener(listener: () => void): void;
	removeChangeListener(listener: () => void): void;
}

type FluxStore = ChangeSource;
```

`ChangeSource` is what `useStore` and `subscribe` need. A Flux store has it. So do [`mist.settings`](core.md#mistsettings), [`mist.data`](core.md#mistdata), and a [`state`](ui.md#state) from `@aurologic/mist-api/ui`, and any emitter a plugin writes:

```ts
class Queue implements ChangeSource {
	items: string[] = [];
	private readonly listeners = new Set<() => void>();
	addChangeListener(listener: () => void) { this.listeners.add(listener); }
	removeChangeListener(listener: () => void) { this.listeners.delete(listener); }
	push(item: string) {
		this.items = [...this.items, item];
		for (const listener of [...this.listeners]) listener();
	}
}
```

`FluxStore` is the base of the Discord store types. Extend it to type a store that `stores` doesn't list:

```ts
interface TypingStore extends FluxStore {
	getTypingUsers(channelId: string): Record<string, number>;
}
```

## stores

```ts
const stores: {
	readonly user: UserStore | undefined;
	readonly channel: ChannelStore | undefined;
	readonly guild: GuildStore | undefined;
	readonly selectedChannel: SelectedChannelStore | undefined;
	readonly multiAccount: MultiAccountStore | undefined;
	readonly presence: PresenceStore | undefined;
	readonly sessions: SessionsStore | undefined;
	readonly streamerMode: StreamerModeStore | undefined;
	readonly messages: MessageStore | undefined;
	readonly readStates: ReadStateStore | undefined;
	readonly voiceStates: VoiceStateStore | undefined;
	readonly guildMembers: GuildMemberStore | undefined;
	readonly relationships: RelationshipStore | undefined;
	readonly permissions: PermissionStore | undefined;
};
```

Each property is a getter that calls [`store`](#store) with the store's name when you read it. It is `undefined` until Discord has created the store, and while Discord's webpack isn't ready. The next read looks again. Reading a property again is cheap, because Evi caches stores by name. Read it where you use it instead of keeping it in a module-level constant.

`stores.messages` throws Evi's `PluginPermissionError` for a plugin whose manifest declares `permissions` without `readMessages`: Evi holds every message store to that flag.

| Property | Store | Methods |
| --- | --- | --- |
| `user` | `UserStore` | `getCurrentUser?(): User \| undefined` (optional: call it with `?.()`), `getUser(id): User \| undefined` |
| `channel` | `ChannelStore` | `getChannel(id): Channel \| undefined` |
| `guild` | `GuildStore` | `getGuild(id): Guild \| undefined`, `getGuilds(): Record<string, Guild>` |
| `selectedChannel` | `SelectedChannelStore` | `getChannelId(guildId?): string \| undefined`, `getVoiceChannelId(): string \| null` |
| `multiAccount` | `MultiAccountStore` | `getUsers(): unknown` |
| `presence` | `PresenceStore` | `getClientStatus?(userId): ClientStatuses \| null \| undefined` |
| `sessions` | `SessionsStore` | `getSessions?(): Record<string, Session> \| null \| undefined` |
| `streamerMode` | `StreamerModeStore` | `enabled?: boolean`, `isEnabled?(): boolean`, `getState?(): { enabled?: boolean } \| null \| undefined` |
| `messages` | `MessageStore` | `getMessages(channelId): ChannelMessages \| undefined`, `getMessage(channelId, messageId): Message \| undefined` |
| `readStates` | `ReadStateStore` | `hasUnread(channelId): boolean`, `getMentionCount(channelId): number`, `ackMessageId(channelId)`, the last message read, and `lastMessageId(channelId)`, both `string \| null \| undefined` |
| `voiceStates` | `VoiceStateStore` | `getVoiceStateForUser(userId): VoiceState \| undefined`, `getVoiceStatesForChannel(channelId): Record<string, VoiceState>` (by user id), `isInChannel(channelId, userId?): boolean` (you, without `userId`) |
| `guildMembers` | `GuildMemberStore` | `getMember(guildId, userId): GuildMember \| null \| undefined`, `getNick(guildId, userId): string \| null \| undefined`, `getMembers(guildId): GuildMember[]` |
| `relationships` | `RelationshipStore` | `getRelationshipType(userId): number`, `isFriend(userId): boolean`, `isBlocked(userId): boolean`, `getFriendIDs(): string[]`, `getNickname?(userId): string \| null \| undefined` |
| `permissions` | `PermissionStore` | `can(permission: bigint, context: Channel \| Guild): boolean`, `canAccessGuildSettings(guild): boolean`, `computePermissions(context): bigint` |

`MultiAccountStore.getUsers` returns `unknown` on purpose. Its shape changes between Discord builds: parse it before use.

`PresenceStore.getClientStatus` gives someone else's status on each device. Discord doesn't send you yours: read your devices from `SessionsStore.getSessions`. Both methods are optional; call them with `?.()`.

`RelationshipStore.getRelationshipType` gives Discord's number: 0 for none, 1 for a friend, 2 for blocked, 3 for an incoming request, and 4 for an outgoing one. `RelationshipStore.getNickname` is the nickname you gave a friend. It is optional, because Discord builds from before friend nicknames lack it. [`displayName`](discord.md#displayname) reads it for you.

`PermissionStore.can` takes one of Discord's permission bits as a `bigint`, as in `1n << 11n` for Send Messages, and checks it for you.

The `User`, `Channel`, `Guild`, `ClientStatuses`, `Session`, `Message`, `ChannelMessages`, `VoiceState`, `GuildMember`, and `RelationshipType` types are exported too:

```ts
interface User { id: string; username: string; globalName?: string | null; discriminator?: string; avatar?: string | null; bot?: boolean; }
interface Channel { id: string; type: number; guild_id?: string | null; name?: string; }
interface Guild { id: string; name: string; }
type ClientStatuses = Partial<Record<string, string>>;
interface Session { status?: unknown; clientInfo?: { client?: unknown; }; }
interface Message { id: string; channel_id: string; content: string; author: User; type?: number; }
interface ChannelMessages { toArray(): Message[]; get?(id: string): Message | undefined; has?(id: string): boolean; readonly length?: number; }
interface VoiceState { userId: string; channelId: string | null; guildId?: string | null; mute?: boolean; deaf?: boolean; selfMute?: boolean; selfDeaf?: boolean; selfVideo?: boolean; selfStream?: boolean; }
interface GuildMember { userId: string; guildId: string; nick?: string | null; roles: string[]; avatar?: string | null; }
type RelationshipType = number;
```

`ClientStatuses` maps a device to a status, as in `{ desktop: "online", mobile: "idle" }`. `Session` fields are `unknown` because their shape isn't stable across Discord builds. `ChannelMessages.toArray()` gives the channel's loaded messages, oldest first.

## store

```ts
function store<T = unknown>(name: string): T | undefined;
```

Discord's Flux store by name, or `undefined` while Discord hasn't made it or its webpack isn't loaded. It is `findStore` without the throw, for a store that `stores` doesn't list. A store that the plugin's manifest doesn't permit, such as `MessageStore` without `readMessages`, still throws Evi's `PluginPermissionError`: a missing permission doesn't look like a missing store.

```ts
const typing = store<TypingStore>("TypingStore")?.getTypingUsers(channelId) ?? {};
```

## whenStore

```ts
function whenStore<T = unknown>(name: string, options?: AbortSignal | WhenStoreOptions): Promise<T>;

interface WhenStoreOptions {
	signal?: AbortSignal;
	timeout?: number;
}
```

Resolves with Discord's store once Discord has made it, and at once when it has. It waits through Evi's `waitFor`. Pass a signal bare, or a signal and a timeout as `{ signal, timeout }`.

- When `signal` aborts, it stops waiting and rejects with the signal's reason.
- After `timeout` milliseconds, it stops waiting and rejects with a `TimeoutError` `DOMException`. Without `timeout`, it waits as long as it takes. `timeout` follows the [timer limits](util.md#timer-limits).

```ts
async start() {
	const voice = await whenStore<VoiceStateStore>("VoiceStateStore", { signal: mist.signal, timeout: 30_000 });
	mist.log.info("in voice:", voice.isInChannel(channelId));
}
```

## lookup

```ts
function lookup<T>(filter: Filter): () => T | undefined;
```

Returns a finder for one export of Discord's webpack. Each call searches with Evi's `find` until it finds something, and then keeps it. Until then, and while webpack isn't loaded, it gives `undefined` instead of throwing. Make it at module level and call it where you use it: the search runs once, on first use.

```ts
import { filters } from "@evi/api";

const parser = lookup<{ parse(text: string): ReactNode; }>(filters.byProps("parse", "parseTopic"));

const rendered = parser()?.parse(text) ?? text;
```

Don't keep a bare function this way. A kept function is the one `find` found, and a hook that another plugin or Evi puts on that export later doesn't run through it. Keep the object that holds the function, as above, and read the function from it at each call. For an export that is a bare function, call `find` at each call instead.

## currentUserId

```ts
function currentUserId(): string | undefined;
```

The logged-in account's id, or `undefined` when `UserStore` or the current user isn't there yet. Each step is called optionally: a Discord build that renames a method gives `undefined` instead of a throw.

```ts
const me = currentUserId();
```

## isStreamerMode

```ts
function isStreamerMode(): boolean;
```

Whether Streamer Mode is on. Discord builds have shown this as an `enabled` field, an `isEnabled()` method, or `getState().enabled`. `StreamerModeStore` types all three as optional, and `isStreamerMode` reads each. It gives `false` while the store isn't there yet. Use it to hide private text, such as a message preview, while the user is streaming.

```ts
const body = isStreamerMode() ? t("hidden") : preview;
```

## subscribe

```ts
type Source = ChangeSource | string | undefined;
type Sources = Source | readonly Source[];

function subscribe(watched: Sources, listener: () => void): () => void;
```

Calls `listener` each time a source in `watched` emits a change, for code outside React. It returns the unsubscribe function, which removes every listener it added. Pass it to `mist.ctx.onDispose` to remove the listeners when the plugin stops.

In `start`, name Discord's stores instead of reading them from `stores`. Evi starts plugins as soon as Discord's React and dispatcher exist, often before Discord has made stores such as `PresenceStore`:

```ts
start(ctx) {
	ctx.onDispose(subscribe(["PresenceStore", "SessionsStore"], redraw));
},
```

A name is the store's name as Discord gives it. `subscribe` listens at once to a store that already exists. For a store that doesn't, it waits through Evi's `waitFor`, starts listening when Discord makes it, and calls `listener` once then: the store may have changed before it was listened to. Unsubscribing before then stops the wait. Naming a store that the manifest doesn't permit, such as `"MessageStore"` without `readMessages`, throws Evi's `PluginPermissionError`, as [`store`](#store) does.

A store or other `ChangeSource` you pass is listened to as it is. An entry that is `undefined` is skipped and isn't listened to later: `subscribe([stores.presence], redraw)` in `start` can silently listen to nothing. `mist.define` warns about each store that a `stores` getter reads as missing during the synchronous part of `start`, as [Stores read too early](core.md#stores-read-too-early) describes.

- If a source throws when it is subscribed to, as a permission check does, `subscribe` first removes the listeners it already added for the sources before it, then throws. Nothing is left listening.
- Subscribing the same listener twice gives two subscriptions, and each unsubscribe removes only its listener.

## useStore

```ts
function useStore<T>(
	watched: Sources,
	getter: () => T,
	deps?: readonly unknown[],
): T;
```

Returns `getter()` and re-renders the component when a source in `watched` emits a change. A source is a Flux store's name, a Flux store, or any other `ChangeSource`, as for `subscribe`. It is built on `React.useSyncExternalStore`.

Name Discord's stores, as with `subscribe`: a name works even when the component first renders before Discord has made the store.

```tsx
function CurrentChannel() {
	const name = useStore("SelectedChannelStore", () => {
		const id = stores.selectedChannel?.getChannelId();
		return id ? stores.channel?.getChannel(id)?.name ?? null : null;
	});
	return <span>{name ?? "No channel"}</span>;
}
```

### The value is cached

`useStore` keeps the getter's last value until a source in `watched` emits a change, the sources in `watched` change, or a value in `deps` changes. Values are compared with `Object.is`. The getter can therefore build a new object or array on every call, and the component still re-renders only on a change.

The flip side: `useStore` doesn't see anything the getter reads besides the sources. List those values, such as props and state, in `deps`, as with `useMemo`:

```tsx
import { displayName } from "@aurologic/mist-api/discord";

function UserName({ id }: { id: string; }) {
	const user = useStore("UserStore", () => stores.user?.getUser(id), [id]);
	return <span>{displayName(user, { fallback: id })}</span>;
}
```

Without `[id]`, a new `id` prop would keep showing the old user until `UserStore` next changed.

### Several sources, and sources that change

Pass an array to listen to several sources. A name is listened to once Discord makes the store, and the component re-renders then.

The array is compared item by item on each render, not by identity. A new array literal with the same items keeps the subscription. An array whose items or length change between renders, such as one built from props, re-subscribes to the new list and builds the value again. That is safe in a hook, unlike a changing number of hook calls.

An entry can also be `undefined`. If the component renders again after such a store arrives, `useStore` starts listening to it then. The store arriving doesn't make the component render by itself, though: name a store that may not exist yet.

```tsx
function GuildCount() {
	const count = useStore(["GuildStore"], () => Object.keys(stores.guild?.getGuilds() ?? {}).length);
	return <span>{count}</span>;
}
```

On unmount, `useStore` removes every listener it added.
