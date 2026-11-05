# Stores

`@aurologic/mist-api/stores` types the Discord Flux stores that plugins use. It gives a React hook that re-renders when they change, and a listener for code outside React. It runs on the page side only, because it imports `findStore` and `React` from `@evi/api`.

```ts
import { type ChangeSource, currentUserId, type FluxStore, isStreamerMode, type Source, type Sources, stores, subscribe, useStore } from "@aurologic/mist-api/stores";
```

The store interfaces are minimal. Each lists only the methods plugins call. A store method that isn't listed still exists at runtime, and a plugin can extend the interface to use it.

## ChangeSource and FluxStore

```ts
interface ChangeSource {
	addChangeListener(listener: () => void): void;
	removeChangeListener(listener: () => void): void;
}

interface FluxStore extends ChangeSource { }
```

`ChangeSource` is what `useStore` and `subscribe` need. A Flux store has it, and so can a plugin's own emitter:

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
};
```

Each property is a getter that calls `findStore` with the store's name when you read it. It is `undefined` until Discord has created the store. It is also `undefined` while Discord's webpack isn't ready, when `findStore` throws. The next read looks again. mist-api keeps no record of a miss, so how often a miss is looked up again is up to Evi. Reading a property again is cheap, because Evi caches stores by name. Read it where you use it instead of keeping it in a module-level constant.

| Property | Store | Methods |
| --- | --- | --- |
| `user` | `UserStore` | `getCurrentUser?(): User \| undefined` (optional, so call it with `?.()`), `getUser(id): User \| undefined` |
| `channel` | `ChannelStore` | `getChannel(id): Channel \| undefined` |
| `guild` | `GuildStore` | `getGuild(id): Guild \| undefined`, `getGuilds(): Record<string, Guild>` |
| `selectedChannel` | `SelectedChannelStore` | `getChannelId(guildId?): string \| undefined`, `getVoiceChannelId(): string \| null` |
| `multiAccount` | `MultiAccountStore` | `getUsers(): unknown` |
| `presence` | `PresenceStore` | `getClientStatus?(userId): ClientStatuses | null | undefined` |
| `sessions` | `SessionsStore` | `getSessions?(): Record<string, Session> | null | undefined` |
| `streamerMode` | `StreamerModeStore` | `enabled?: boolean`, `isEnabled?(): boolean`, `getState?(): { enabled?: boolean } | null | undefined` |

`MultiAccountStore.getUsers` returns `unknown` on purpose. Its shape changes between Discord builds, so parse it before use.

`PresenceStore.getClientStatus` gives someone else's status on each device. Discord doesn't send you your own, so read your own devices from `SessionsStore.getSessions`. Both methods are optional, so call them with `?.()`.

The `User`, `Channel`, `Guild`, `ClientStatuses`, and `Session` types are exported too:

```ts
interface User { id: string; username: string; globalName?: string | null; discriminator?: string; avatar?: string | null; bot?: boolean; }
interface Channel { id: string; type: number; guild_id?: string | null; name?: string; }
interface Guild { id: string; name: string; }
type ClientStatuses = Partial<Record<string, string>>;
interface Session { status?: unknown; clientInfo?: { client?: unknown; }; }
```

`ClientStatuses` maps a device to a status, as in `{ desktop: "online", mobile: "idle" }`. `Session` fields are `unknown` because their shape isn't stable across Discord builds.

## currentUserId

```ts
function currentUserId(): string | undefined;
```

The logged-in account's id, or `undefined` when `UserStore` or the current user isn't there yet. Each step is called optionally, so a Discord build that renames a method gives `undefined` instead of a throw.

```ts
const me = currentUserId();
```

## isStreamerMode

```ts
function isStreamerMode(): boolean;
```

Whether Streamer Mode is on. Discord builds have shown this as an `enabled` field, an `isEnabled()` method, or `getState().enabled`, so `StreamerModeStore` types all three as optional and `isStreamerMode` reads each. It gives `false` while the store isn't there yet. Use it to hide private text, such as a message preview, while the user is streaming.

```ts
const body = isStreamerMode() ? t("hidden") : preview;
```

## subscribe

```ts
type Source = ChangeSource | string | undefined;
type Sources = Source | readonly Source[];

function subscribe(watched: Sources, listener: () => void): () => void;
```

Calls `listener` each time a source in `watched` emits a change, for code outside React. It returns the unsubscribe function, which removes every listener it added. Pass it to `mist.ctx.onDispose` so the listeners go when the plugin stops.

In `start`, name Discord's stores instead of reading them from `stores`. Evi starts plugins as soon as Discord's React and dispatcher exist, which is often before Discord has made stores such as `PresenceStore`:

```ts
start(ctx) {
	ctx.onDispose(subscribe(["PresenceStore", "SessionsStore"], redraw));
},
```

A name is the store's name as Discord gives it. `subscribe` listens at once to a store that already exists. It waits for a store that doesn't, through Evi's `waitFor`, starts listening when Discord makes it, and calls `listener` once then, because the store may have changed before it was listened to. Unsubscribing before then stops the wait.

A store or other `ChangeSource` you pass is listened to as it is. An entry that is `undefined` is skipped and isn't listened to later, so `subscribe([stores.presence], redraw)` in `start` can silently listen to nothing. `mist.define` warns about each store that a `stores` getter reads as missing during the synchronous part of `start`, as [Stores read too early](core.md#stores-read-too-early) describes. Subscribing the same listener twice gives two subscriptions, and each unsubscribe removes only its own.

## useStore

```ts
function useStore<T>(
	watched: Sources,
	getter: () => T,
	deps?: readonly unknown[],
): T;
```

Returns `getter()` and re-renders the component when a source in `watched` emits a change. A source is a Flux store, a Flux store's name, or any other `ChangeSource`, as for `subscribe`. It is built on `React.useSyncExternalStore`.

```tsx
function CurrentChannel() {
	const name = useStore(stores.selectedChannel, () => {
		const id = stores.selectedChannel?.getChannelId();
		return id ? stores.channel?.getChannel(id)?.name ?? null : null;
	});
	return <span>{name ?? "No channel"}</span>;
}
```

### The value is cached

`useStore` keeps the getter's last value until a store in `watched` emits a change, the stores in `watched` change, or a value in `deps` changes. Values are compared with `Object.is`. So the getter can build a new object or array on every call, and the component still re-renders only on a change.

The other side of the cache is that `useStore` doesn't see anything the getter reads besides the stores. List those values, such as props and state, in `deps`, like `useMemo`:

```tsx
function UserName({ id }: { id: string; }) {
	const user = useStore(stores.user, () => stores.user?.getUser(id), [id]);
	return <span>{user?.globalName ?? user?.username ?? id}</span>;
}
```

Without `[id]`, a new `id` prop would keep showing the old user until `UserStore` next changed.

### Several stores, and stores that arrive late

Pass an array to listen to several stores. A name is listened to once Discord makes the store, and the component re-renders then. An entry can also be `undefined`. If the component renders again after such a store arrives, `useStore` starts listening to it then, because the subscription depends on the stores themselves and not on the array. But the store arriving doesn't make the component render, so name a store that may not exist yet.

```tsx
function GuildCount() {
	const count = useStore([stores.guild, stores.user], () => Object.keys(stores.guild?.getGuilds() ?? {}).length);
	return <span>{count}</span>;
}
```

On unmount, `useStore` removes every listener it added.
