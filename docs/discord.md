# Discord

`@aurologic/mist-api/discord` reaches the parts of Discord's app that many plugins rebuild for themselves. It runs on the page side only, because it imports from `@evi/api`. It covers:

- **Accounts:** the saved accounts, the signed-in account, account switches, and work per account.
- **The API:** Discord's API client, a channel's messages, and the account's synced settings and custom status.
- **Navigation and ids:** Discord's router, message links, and Discord ids.
- **Display:** display names, avatars, and dates and durations in Discord's language.
- **The message box and clipboard:** text typed into the box, messages only you see, and copying.

```ts
import { accounts, avatarUrl, chat, copy, discord, DiscordApiError, displayName, format, navigate, parseMessageLink, PluginPermissionError, snowflake, UnknownPluginError, whenConnected } from "@aurologic/mist-api/discord";

const api = discord(mist);
```

`discord(mist)` takes the plugin's `mist` object, from `createMist`, and returns `{ rest, messages, settings, status }` for that plugin. `createMist` registers the object, and `discord(mist)` works at module level right after it. A string id or a look-alike object throws a `TypeError`: mist has to know which plugin is asking to hold its requests to its manifest. [Which plugin is asking](security.md#which-plugin-is-asking) explains the check.

A plugin's bundle carries only the parts it imports.

## Permissions

Evi holds a plugin to the `permissions` in its `manifest.json`. Evi's [plugin guide](https://github.com/BleedDev/evi/blob/main/docs/plugins.md) lists them. This table says what to declare for each part of this module.

| You use | Declare |
| --- | --- |
| `api.messages` | `"network": ["discord.com"]` and `"readMessages": true` |
| `api.rest.get` or `api.rest.post` on a path that answers with messages (see [Message reads](#message-reads)) | `"network": ["discord.com"]` and `"readMessages": true` |
| `api.rest` to post, edit, or delete messages, or to use interactions, webhooks, or new threads | `"network": ["discord.com"]` and `"sendMessages": true` |
| `api.rest` to change your account, profile, or settings (`/users/@me...`) | `"network": ["discord.com"]` and `"changeSettings": true` |
| `api.settings.update`, `api.status.set` | `"network": ["discord.com"]` and `"changeSettings": true` |
| `api.rest` on any other endpoint | `"network": ["discord.com"]` |
| `accounts`, `whenConnected`, `api.status.get`, `navigate`, `snowflake`, `displayName`, `avatarUrl`, `copy`, `format`, `parseMessageLink`, `chat` | Nothing |

`api.rest` and `api.messages` send requests through Discord's API client, not the plugin's `fetch`, where Evi's guard can't see them. mist holds them to the plugin's declaration by the rules Evi applies to the plugin's `fetch`:

- A plugin whose manifest has no `permissions` isn't held to anything, as in Evi.
- Every request needs `network` to cover `discord.com`. A listed host covers its subdomains.
- A `POST`, `PUT`, `PATCH`, or `DELETE` to a message, thread, interaction, or webhook endpoint needs `sendMessages`.
- A `POST`, `PUT`, `PATCH`, or `DELETE` to `/users/@me`, its settings, profile, consent, or connections needs `changeSettings`.
- `api.settings.update` and `api.status.set` save through Discord's settings updater, which sends `PATCH /users/@me/settings-proto/<type>`. They need what that request needs: `network` and `changeSettings`.
- A `GET` or `POST` that reads messages needs `readMessages` (see [Message reads](#message-reads)). Other `GET` requests need only `network`.

mist reads the path as Discord's API does. It resolves the path against `/api/v9`, decodes `%`-escapes (which makes `/users/%40me` the same as `/users/@me`), and drops repeated and trailing slashes, the query, and the fragment. A path it can't read, or that climbs out of `/api/`, needs every write flag, and for a `GET` or `POST`, `readMessages` too. mist reads the declaration from `Evi.plugins` at each request and follows an update.

An id that matches no plugin Evi has loaded throws an `UnknownPluginError` at each request, before anything is sent: a made-up id doesn't count as a plugin that declares nothing. A refused request throws a `PluginPermissionError` before anything is sent. Its `permission` names what to declare, and its `message` matches Evi's, as in `example can't send messages (discord.com): its manifest doesn't declare permissions.sendMessages`.

These checks mirror Evi's guard and catch what an honest plugin forgot to declare. [What the check is for](security.md#what-the-check-is-for) says what they don't do.

Some parts need nothing in `permissions` but still show on the plugin's store page and in its review:

- `copy` writes to the clipboard. The store lists clipboard use, and the review notes `DiscordNative.clipboard`.
- `accounts.switchTo` changes the account Discord is signed in to, and `accounts.openLogin` opens Discord's login for another account. Say so in the plugin's description.
- `chat.localMessage` uses Discord's message actions to show a message that only you see. It sends nothing.

### Message reads

A request through `api.rest` needs `readMessages` when its path answers with messages:

- `GET /channels/<id>/messages`, and everything under it: one message, a channel search.
- `GET /channels/<id>/pins`
- `GET /channels/<id>/threads/search`
- `GET /guilds/<id>/messages/search`
- `GET /users/@me/mentions`
- `POST /channels/<id>/post-data` (forum posts with their first messages)

The match ends at the endpoint's name: `/channels/<id>/messages?limit=1` and `/channels/<id>/messages;x` are reads too.

A `GET` or `POST` path mist can't read safely fails closed and counts as a message read. That is a path whose `%`-escapes don't decode, one that climbs out of `/api/`, or one with a control character or a `;` after decoding, which no Discord route has. A plugin without `readMessages` can't reach messages through an odd spelling of a path.

## accounts

Discord's saved accounts, the account Discord is signed in to, and account switches.

### accounts.list

```ts
type TokenStatus = "valid" | "validating" | "invalid";

interface SavedAccount {
	id: string;
	username: string;
	discriminator: string;
	avatar: string | null;
	status: TokenStatus;
}

accounts.list(): SavedAccount[];
```

The accounts in Discord's Switch Accounts list, in Discord's order. The list is empty until Discord makes `MultiAccountStore`.

`MultiAccountStore.getUsers()` has given an array in some Discord builds and an object keyed by id in others, and `list` reads both. It drops an entry without an id and a second entry with the same id. A missing `username` becomes the id, and a missing `discriminator` becomes `"0"`, which is what accounts with the new usernames have. `status` is `"invalid"` when Discord will ask for the account's password again. A status that Discord adds later counts as `"valid"`.

Each entry copies only the fields above. The store's entries also hold a push token, which `list` never copies.

```ts
const others = accounts.list().filter(a => a.id !== accounts.current() && a.status !== "invalid");
```

### accounts.current

```ts
accounts.current(): string | undefined;
```

The id of the account Discord is signed in to. During a switch, Discord's `UserStore` has no current user until the new account connects. In that time, `current` gives the id of the account Discord is switching to, read from Discord's `MultiAccountSwitchStore`. It gives `undefined` when you are logged out and before Discord has connected.

### accounts.on

```ts
interface AccountEvents {
	switching: { from: string | undefined; to: string | undefined; };
	signedOut: { id: string | undefined; };
	connected: { id: string; from: string | undefined; };
}

accounts.on<E extends keyof AccountEvents>(event: E, listener: (detail: AccountEvents[E]) => void): () => void;
```

Calls `listener` each time `event` happens, and returns the unsubscribe function. Pass it to `mist.ctx.onDispose`.

- `switching`: a switch began. `from` is the account it leaves and `to` the account it goes to. `to` is `undefined` when Discord logged out to switch without saying first where to.
- `connected`: Discord connected as `id`. After a switch, `from` is the account the switch left. When the connection wasn't a switch, such as a reconnect after the network dropped or the first connection after start, `from` is `undefined`. When a switch fails, Discord connects as the account it left, and `id` equals `from`.
- `signedOut`: you logged out, and not to switch. `id` is the account that was signed in, when it is known.

```ts
start(ctx) {
	ctx.onDispose(accounts.on("switching", () => cache.clear()));
	ctx.onDispose(accounts.on("connected", ({ id, from }) => {
		if (from && from !== id) mist.log.info(`switched from ${from} to ${id}`);
	}));
},
```

The events come from Discord's `MULTI_ACCOUNT_SWITCH_START`, `LOGOUT`, and `CONNECTION_OPEN` actions. One switch gives one `switching`, whichever of the first two actions comes first.

A listener that throws doesn't stop the other listeners or Discord's handlers. Its error is printed with `console.error`, as in `accounts.on: a "connected" listener threw:`, instead of being thrown into Discord's dispatch.

A plugin that starts during a switch takes the switch from Discord's `MultiAccountSwitchStore`. The `connected` that ends the switch then has `from` set to `undefined`.

### accounts.switchTo

```ts
type SwitchResult = "switched" | "already" | "needsLogin" | "failed";

accounts.switchTo(id: string, options?: { synchronously?: boolean; }): Promise<SwitchResult>;
```

Switches to a saved account with Discord's switch function, the one its Switch Accounts menu calls, and says what Discord answered:

| Result | Means |
| --- | --- |
| `"switched"` | Discord took the account's saved login. |
| `"already"` | Discord is signed in to `id` already. Nothing was called. |
| `"needsLogin"` | Discord has no login saved for the account, as after it was signed out elsewhere. Call `accounts.openLogin()` to let the user sign in. |
| `"failed"` | Discord refused the login, or its switch threw. A throw is printed with `console.error`. |

`synchronously` is passed to Discord as its `switchSynchronously` argument. Left out, Discord does what its menu does. It rejects with a `TypeError` when `id` isn't a Discord id, and with an `Error` when Discord's switch function can't be found.

It resolves when Discord has taken the account's login, which is before the account connects. To wait for the connection, await `whenConnected()` next:

```ts
const result = await accounts.switchTo(id, { synchronously: false });
if (result === "needsLogin") accounts.openLogin();
else if (result === "switched") await whenConnected();
```

### accounts.openLogin

```ts
accounts.openLogin(): boolean;
```

Opens Discord's login for adding an account, the one its Switch Accounts menu opens with Add an Account. Its back button goes to Discord's Switch Accounts list. It returns `false` when Discord's function can't be found.

### accounts.scope

```ts
type AccountRun = (accountId: string, signal: AbortSignal) => void | (() => void) | Promise<void | (() => void)>;

accounts.scope(run: AccountRun, options?: { settleMs?: number; }): () => void;
```

Runs work for one account at a time, for plugins that keep per-account state, timers, or listeners. It calls `run(accountId, signal)` for the account Discord is connected as: at once when Discord is connected already, and otherwise when it connects.

- When the account switches or signs out, `signal` aborts with a `DOMException` named `AbortError` and the message `Account changed`, and the cleanup function that `run` returned is called.
- When Discord connects as the next account, `run` is called again for it. A reconnection to the same account doesn't run it again.
- `settleMs` (default 0) waits that long after a connection before `run`, because Discord fills many stores a moment after it connects. It isn't waited when Discord is connected already, and a switch during the wait cancels the run. It follows the [timer limits](util.md#timer-limits).
- `run` can be async and resolve with its cleanup. A cleanup that arrives after the account left is called at once.
- An error that `run` or its cleanup throws, or a rejection, is printed with `console.error`, as in `accounts.scope: run threw:`, and never thrown into Discord's dispatch.

The function `scope` returns stops it and ends the current run: pass it to `ctx.onDispose`. A `run` that isn't a function throws a `TypeError`.

```ts
start(ctx) {
	ctx.onDispose(accounts.scope((accountId, signal) => {
		const timer = setInterval(() => void refreshBadges(accountId, signal), 60_000);
		return () => clearInterval(timer);
	}, { settleMs: 2000 }));
},
```

### whenConnected

```ts
function whenConnected(signal?: AbortSignal): Promise<string>;
```

Resolves with the account id once Discord is connected, and at once when it already is. During a switch, it waits for the new account. With a `signal`, it rejects with `signal.reason` when the signal aborts, and stops listening.

```ts
async start() {
	const id = await whenConnected(mist.signal);
	mist.log.info(`connected as ${id}`);
},
```

## api.rest

```ts
interface RestOptions {
	query?: Record<string, string | number | boolean | null | undefined>;
	body?: unknown;
	headers?: Record<string, string>;
	reason?: string;
	signal?: AbortSignal;
}

api.rest.get(path: string, options?: RestOptions): Promise<unknown>;
api.rest.post(path: string, options?: RestOptions): Promise<unknown>;
api.rest.put(path: string, options?: RestOptions): Promise<unknown>;
api.rest.patch(path: string, options?: RestOptions): Promise<unknown>;
api.rest.del(path: string, options?: RestOptions): Promise<unknown>;
```

Sends a request to Discord's API with Discord's API client, as the account that is signed in. The client adds the login, the API version, and Discord's headers. It also holds back a request to a path that answered 429 until the wait is over. The plugin never sees the login.

`path` is the path after `/api/v<n>`, such as `/users/@me` or `/channels/123/messages`. A path that doesn't start with exactly one `/`, or that contains a control character or a `.` or `..` segment (plain or `%2e`-encoded), rejects with a `TypeError` before anything is sent: Discord's client would sign a full URL to another site too, and dot segments could climb to another route. A request the manifest doesn't declare rejects with a `PluginPermissionError`, also before anything is sent.

The result is the parsed body of a 2xx answer, or `undefined` when there is none. It is `unknown` on purpose: check it before use.

| Option | Effect |
| --- | --- |
| `query` | Added to the URL. A `null` or `undefined` value is left out. |
| `body` | Sent as JSON. |
| `headers` | Added to Discord's headers. |
| `reason` | Sent as `X-Audit-Log-Reason`, which a server's audit log shows for moderation actions. |
| `signal` | Aborts the request. The promise then rejects with `signal.reason`. |

```ts
// Reads messages: the manifest declares readMessages
const pins = await api.rest.get(`/channels/${channelId}/pins`);
if (!Array.isArray(pins)) throw new Error("Unexpected answer");
```

## DiscordApiError

```ts
class DiscordApiError extends Error {
	readonly status: number;
	readonly code: number | undefined;
	readonly retryAfter: number | undefined;
	readonly body: unknown;
	readonly method: string;
	readonly path: string;
}
```

What `api.rest` and `api.messages` throw for an answer outside 2xx. `name` is `"DiscordApiError"`.

| Field | Value |
| --- | --- |
| `status` | The HTTP status. It is `0` when the request got no answer, such as when the network is down. |
| `code` | Discord's JSON error code, such as `50001` for Missing Access or `10003` for Unknown Channel. |
| `retryAfter` | For a 429, the number of seconds to wait before asking again. |
| `body` | The answer's parsed body. |
| `method` | `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`. |
| `path` | The path the request was sent to. |

`message` names all of these, as in `GET /channels/1/messages: 404 Unknown Channel (code 10003)`.

```ts
try {
	await api.rest.get(`/channels/${channelId}/messages`, { query: { limit: 1 } });
} catch (err) {
	if (err instanceof DiscordApiError && err.code === 50001) return null;
	throw err;
}
```

## PluginPermissionError

```ts
class PluginPermissionError extends Error {
	readonly plugin: string;
	readonly permission: "network" | "readMessages" | "sendMessages" | "changeSettings";
	readonly target: string;
}
```

What `api.rest` and `api.messages` throw for a request the plugin's manifest doesn't declare, before anything is sent. `name` is `"PluginPermissionError"`, as for Evi's refusals. `target` is `discord.com` for a missing `network`, `sendMessages`, or `changeSettings`. For a message read, it is the request's path for `api.rest` and the channel's messages path for `api.messages`.

## api.messages

```ts
interface ApiMessage {
	id: string;
	channel_id: string;
	content: string;
	timestamp: string;
	author: { id: string; username: string; [field: string]: unknown; };
	[field: string]: unknown;
}

type MessagesOptions = ({ before?: string; } | { after: string; }) & {
	limit?: number;
	signal?: AbortSignal;
};

api.messages(channelId: string, options?: MessagesOptions): AsyncGenerator<ApiMessage>;
```

A channel's messages, one at a time, fetched in pages of up to 100. Use it with `for await`.

- Without `before` or `after`, it starts at the newest message and goes back, newest first.
- With `before`, it starts at the message before that id and goes back, newest first.
- With `after`, it starts at the message after that id and goes forward, oldest first.

To start from a time instead of a message, pass [`snowflake.at(ms)`](#snowflake) as `before` or `after`. `before` and `after` can't both be given: TypeScript refuses it, and at run time it throws a `TypeError`. `limit` is the number of messages in all, a finite number from 0, and the default is every message there is. It asks for no more messages than `limit` needs.

`api.messages` checks its arguments and the plugin's permissions when you call it, before the loop starts. A bad channel or message id, `before` with `after`, a bad `limit`, and a missing `readMessages` throw there, not at the first `next()`.

It stops at the end of the channel, at `limit`, or when you `break` out of the loop. When Discord answers 429, it waits the `retryAfter` that Discord gives and asks for the same page again, up to 5 times in a row. The wait is at least 50 ms and at most the [timer limit](util.md#timer-limits), and a 429 without `retryAfter` waits 1 second. Any other error is thrown as a `DiscordApiError`. With a `signal`, it stops when the signal aborts, also during a wait, and throws `signal.reason`.

The fields in `ApiMessage` are checked, and an entry that lacks them is skipped. The other fields are as Discord's API sends them, in snake case: check them before use.

```ts
const recent: string[] = [];
for await (const message of api.messages(channelId, { limit: 300 })) {
	if (message.author.id === me) recent.push(message.content);
}
```

## api.settings

```ts
type SettingsProto = "preloaded" | "frecency";
type SaveResult = "saved" | "unchanged" | "failed";

api.settings.update<G = any>(proto: SettingsProto, group: string, change: (value: G) => boolean | void, options?: { timeoutMs?: number; }): Promise<SaveResult>;
```

Changes the signed-in account's synced settings with Discord's settings updater, the code Discord's settings pages use, and waits for Discord to confirm that the account saved them.

Discord keeps these settings in two protos. `"preloaded"` has most settings, such as `status`, `appearance`, and `privacy`. `"frecency"` has favourites and recents, such as `favoriteGifs` and `favoriteEmojis`. `group` names one field of the proto, and `change` gets that group's value to edit in place. Its fields are in camel case, as Discord's generated proto code names them. `G` types that value; without it, the value is `any`.

- When `change` returns `false`, nothing changed. Nothing is saved, and the result is `"unchanged"`.
- Otherwise Discord saves the change at once, as after a click. The result is `"saved"` once Discord dispatches `USER_SETTINGS_PROTO_UPDATE` with `wasSaved` for that proto.
- The result is `"failed"` when Discord's updater can't be found, when Discord refuses the save, or when the updater throws. After a refusal or a throw, it reloads the proto from Discord, which drops the change from this device's queue. An error the updater throws is printed with `console.error`, as is a reload that fails.
- The result is also `"failed"` when Discord doesn't confirm within `timeoutMs` (30000 by default). Nothing is reloaded then: the change stays queued, and Discord may still save it. Reloading would drop it, along with any other change waiting to save.

A proto that isn't one of the two, an empty `group`, or a `change` that isn't a function rejects with a `TypeError`. A `timeoutMs` that isn't a number rejects with a `TypeError`, and one of 0 or below, or past the [timer limit](util.md#timer-limits), with a `RangeError`. It needs `changeSettings`; see [Permissions](#permissions). It writes only to the account Discord is signed in to.

```ts
const result = await api.settings.update<{ emojis?: string[]; }>("frecency", "favoriteEmojis", value => {
	if (value.emojis?.includes("🌧️")) return false;
	value.emojis = [...value.emojis ?? [], "🌧️"];
});
```

## api.status

```ts
interface CustomStatus {
	text: string;
	emojiName?: string;
	emojiId?: string;
	expiresAt?: number;
}

api.status.get(): CustomStatus | null;
api.status.set(status: CustomStatus | null, options?: { timeoutMs?: number; }): Promise<SaveResult>;
```

The signed-in account's custom status. `get` reads it from Discord's `UserSettingsProtoStore`. It gives `null` when there is none, or before Discord has loaded the account's settings. `emojiName` is a Unicode emoji or a custom emoji's name, `emojiId` is a custom emoji's id, and `expiresAt` is when the status ends, in milliseconds since 1970. Each is left out when the status has none.

`set` writes a new status with `api.settings.update`, built as Discord's proto type, or clears it with `null`. It answers `"unchanged"` without saving when the status is already the same. A status needs text, an emoji, or both. It rejects with a `TypeError` for:

- text over 128 characters;
- an `expiresAt` that isn't a time;
- an `emojiId` that isn't a custom emoji's id. That is a Discord id other than `"0"`, which Discord stores for no emoji, and without a leading `0`, which Discord would read back as another id.

It needs `changeSettings`.

```ts
const before = api.status.get();
await api.status.set({ text: "Raining in Lisbon", emojiName: "🌧️", expiresAt: Date.now() + 60 * 60_000 });
// Later
await api.status.set(before);
```

## navigate

```ts
interface ChannelTarget {
	guildId?: string | null;
	messageId?: string;
}

function navigate(path: string): void;
navigate.channel(channelId: string, target?: ChannelTarget): void;
```

`navigate(path)` opens a page of Discord's app with Discord's router, as clicking a link in Discord does. `path` is a path in the app, such as `/channels/@me`, `/channels/<server>/<channel>`, or `/channels/<server>/<channel>/<message>` to jump to a message. A path that doesn't start with exactly one `/`, or that contains a control character or a `.` or `..` segment (plain or `%2e`-encoded), throws a `TypeError`. It throws an `Error` when Discord's router can't be found. The router is looked up at each call: a hook another plugin puts on it later still runs.

`navigate.channel(channelId, target)` opens a channel, or jumps to `target.messageId` in it, and builds the path for you. `guildId` is the channel's server, or `null` for a DM. Left out, it is read from `ChannelStore`. When the store doesn't have the channel, `navigate.channel` throws an `Error` instead of guessing, because a guess would open the wrong page:

```text
navigate.channel: channel 1234567890 isn't in ChannelStore; pass guildId (or null for a DM)
```

Pass `{ guildId }` for a server channel you haven't loaded, or `{ guildId: null }` for a DM. An id that isn't a Discord id throws a `TypeError`. A `MessageLink` from [`parseMessageLink`](#parsemessagelink) fits `ChannelTarget`, and `navigate.channel(link.channelId, link)` follows a pasted link.

```ts
navigate.channel(channelId);
navigate.channel(channelId, { messageId });
navigate.channel(dmChannelId, { guildId: null });
```

## snowflake

```ts
const snowflake: {
	is(value: unknown): value is string;
	assert(value: unknown, what: string): string;
	time(id: string): number;
	at(ms: number): string;
	compare(a: string, b: string): number;
};
```

Discord's ids, which Discord calls snowflakes. An id is an unsigned 64-bit number written as a string of 1 to 20 digits. Its high bits hold the time it was made, and ids sort by age.

- `is(value)` checks that a value is a Discord id: 1 to 20 digits, at most 2⁶⁴ − 1 (`18446744073709551615`). [`isSnowflake`](util.md#issnowflake) from `@aurologic/mist-api/util` checks the digits only.
- `assert(value, what)` returns `value` when it is a Discord id and throws a `TypeError` otherwise. `what` starts the message: pass where the value came from, as in `snowflake.assert(raw, "kick: userId")`.
- `time(id)` is when the id was made, in milliseconds since 1970, as for a message's or an account's creation date.
- `at(ms)` is the smallest id made at `ms`. Pass it as `before` or `after` to [`api.messages`](#apimessages) to page from a time. A time before 2015, Discord's epoch, or past what an id holds throws a `RangeError`.
- `compare(a, b)` sorts ids oldest first: below 0 when `a` is older, above 0 when it is newer, and 0 when they are equal. Use it, not `<` on strings, which sorts `"9"` after `"10"`.

`time` and `compare` throw a `TypeError` for a value that isn't a Discord id.

```ts
const userId = snowflake.assert(input, "ban: userId");
const joined = format.date(snowflake.time(user.id));
const lastDay = api.messages(channelId, { after: snowflake.at(Date.now() - 86_400_000) });
ids.sort(snowflake.compare);
```

## displayName

```ts
interface NamedUser {
	id?: string;
	globalName?: string | null;
	global_name?: string | null;
	username?: string | null;
}

interface DisplayNameOptions {
	guildId?: string | null;
	fallback?: string;
}

function displayName(user: string | NamedUser | null | undefined, options?: DisplayNameOptions): string;
```

The name Discord shows for a user. It reads, in order:

1. Their nickname in `guildId`, from `GuildMemberStore`. This needs the user's id and `guildId`.
2. The nickname you gave them as a friend, from `RelationshipStore.getNickname`. Discord builds without friend nicknames skip this.
3. Their display name: `globalName` from Discord's stores, or `global_name` from its API.
4. Their username.
5. `fallback`, `""` by default.

`user` is a user id, which is looked up in `UserStore`, or a user object.

```ts
const name = displayName(message.author, { guildId: channel.guild_id, fallback: "Someone" });
```

## avatarUrl

```ts
interface AvatarOwner {
	id: string;
	avatar?: string | null;
	discriminator?: string | null;
}

function avatarUrl(user: AvatarOwner, size?: number): string;
```

The URL of a user's avatar on Discord's CDN, as a still image. A Discord `User`, a `SavedAccount`, and an API message's `author` all fit `AvatarOwner`.

`size` is in pixels, 128 by default. The CDN serves powers of two from 16 to 4096, and `avatarUrl` rounds `size` up to the next one.

When the user has no avatar, the result is Discord's default avatar for them. Discord picks one of six from the id for accounts with the new usernames, and one of five from the tag for legacy tags such as `name#1234`.

```tsx
<img src={avatarUrl(account, 32)} width={32} height={32} alt="" />
```

The image loads through Discord's page, not the plugin's `fetch`, and needs no `network` permission.

## copy

```ts
function copy(text: string): Promise<void>;
```

Puts `text` on the clipboard. In Discord's desktop app it uses `DiscordNative.clipboard.copy`, and in a browser `navigator.clipboard.writeText`.

```ts
await copy(message.id);
```

The `DiscordNative` property access and the `clipboard.writeText` call are written out in `copy` itself, not in a helper. Evi's store review and the store's capability list find these uses by searching the plugin's bundle. A plugin that imports `copy` therefore shows its clipboard use as if it had written the code. [Util](util.md#discordnative-types) explains why mist-api has no general `DiscordNative` accessor.

## format

```ts
interface DurationOptions {
	style?: "long" | "short" | "narrow";
	units?: number;
}

format.locale(): string;
format.clock(ms: number): string;
format.duration(ms: number, options?: DurationOptions): string;
format.ago(at: number | Date | string, now?: number): string;
format.date(at: number | Date | string, options?: Intl.DateTimeFormatOptions): string;
format.messageLink(guildId: string | null, channelId: string, messageId?: string): string;
```

Times and dates in Discord's language, the one picked in Discord's Language settings. `toLocaleString()` and `Intl` without a locale use the system's language instead, which can differ. Each function reads the language from Evi's `I18n.discordLocale` when it is called and follows a change in Discord's settings. Formatters are kept per language and options, because making one costs far more than using it.

| Function | Gives | Examples in English |
| --- | --- | --- |
| `locale()` | Discord's language tag | `"en-US"`, `"pt-BR"` |
| `clock(ms)` | A timer's reading. Hours show only when there are some. Below 0 counts as 0. | `"4:05"`, `"1:02:03"` |
| `duration(ms, options)` | A length of time in words, with the largest units that aren't 0 | `"1 hour, 2 minutes"`, `"1 day"` |
| `ago(at, now)` | The time from now to `at`, in the past or the future | `"5 minutes ago"`, `"yesterday"`, `"in 2 hours"`, `"now"` |
| `date(at, options)` | `at` as `Intl.DateTimeFormat` writes it with `options`. The default is `{ dateStyle: "medium" }`. | `"Nov 4, 2026"` |

`duration` shows `units` units, 2 by default, starting at the largest unit that isn't 0. A unit of 0 among them is left out: 1 day and 5 minutes is `"1 day"`. `style` is `"long"` by default, and `"short"` gives `"1 hr, 2 min"`. Below one second it gives `"0 seconds"`.

`ago` uses years, months, weeks, days, hours, and minutes, and says `"now"` for less than a minute either way. It rounds to the nearest whole unit and picks the unit after rounding: 59 minutes 50 seconds is `"1 hour ago"`, not `"60 minutes ago"`. `now` defaults to `Date.now()`.

`date` and `ago` take a timestamp in milliseconds, a `Date`, or a string that `Date.parse` reads, such as an API message's `timestamp`. For a date that isn't valid they give `"Invalid Date"`.

```ts
const sent = format.date(message.timestamp, { dateStyle: "short", timeStyle: "short" });
const elapsed = format.clock(Date.now() - startedAt);
const left = format.duration(endsAt - Date.now());
```

`messageLink` makes the link that Discord's Copy Message Link makes, `https://discord.com/channels/<server>/<channel>/<message>`, with `@me` for a DM when `guildId` is `null`. Without `messageId` it is the channel's link. An id that isn't a Discord id throws a `TypeError`. The link doesn't depend on the language.

## parseMessageLink

```ts
interface MessageLink {
	guildId: string | null;
	channelId: string;
	messageId?: string;
}

function parseMessageLink(text: string): MessageLink | null;
```

Reads a message or channel link as a user pastes it, and gives `null` for anything else. It takes `discord.com`, `ptb.discord.com`, `canary.discord.com`, and `discordapp.com`, with `https://`, `http://`, or no scheme, a trailing slash, and a query or fragment. Spaces and `<>` around the link are ignored. `guildId` is `null` for a DM's `@me`. The whole text must be the link: a link inside a sentence gives `null`.

```ts
const target = parseMessageLink(input);
if (target) navigate.channel(target.channelId, target);
```

## chat

### chat.insertText

```ts
chat.insertText(text: string): boolean;
```

Types `text` into the message box at the cursor. Nothing is sent. It gives `false` when no message box is open. It uses Discord's `ComponentDispatch` and its `INSERT_TEXT` event, which goes to the message box that subscribed last.

```ts
if (!chat.insertText(snippet)) await copy(snippet);
```

### chat.localMessage

```ts
chat.localMessage(text: string, channelId?: string): void;
```

Shows `text` in a channel as Discord's "Only you can see this" message, outside a slash command. Nothing is sent, and the message is gone after a reload. `channelId` defaults to the channel that is open. It throws when no channel is open and none is given, and when Discord's message actions can't be found.

```ts
chat.localMessage(`Exported ${count} messages.`);
```

Inside a slash command, return `{ ephemeral: text }` from `execute` instead, as Evi's plugin guide shows.
