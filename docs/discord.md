# Discord

`@aurologic/mist-api/discord` reaches the parts of Discord's app that many plugins rebuild for themselves. It covers the saved accounts and account switches, work per account, Discord's own API client, the account's synced settings and custom status, Discord's router, avatars, the clipboard, dates and durations in Discord's language, message links, and the message box. It runs on the page side only, because it imports from `@evi/api`.

```ts
import { accounts, avatarUrl, chat, copy, discord, DiscordApiError, format, navigate, parseMessageLink, PluginPermissionError, UnknownPluginError, whenConnected } from "@aurologic/mist-api/discord";

// After mist.define, which registers the mist object that discord() checks
const api = discord(mist);
```

`discord(mist)` takes the plugin's own mist object, from `createMist`, after `mist.define`, and returns `{ rest, messages, settings, status }` for that plugin. It must know which plugin is asking, to hold the plugin's requests to its manifest. It checks the object against the handle that mist's page registry holds for its id, and throws a `TypeError` for anything else: a string id, or another object with the plugin's `id`. Otherwise a plugin could name another plugin and borrow its permissions. [Security model](security.md#permissions-through-mist) explains the check.

A plugin's bundle carries only the parts it imports.

## Permissions

Evi holds a plugin to the `permissions` in its `manifest.json`. Evi's [plugin guide](https://github.com/BleedDev/evi/blob/main/docs/plugins.md) lists them. This table says what to declare for each part of this module.

| You use | Declare |
| --- | --- |
| `api.messages` | `"network": ["discord.com"]` and `"readMessages": true` |
| `api.rest.get` on message endpoints, such as `/channels/<id>/messages` | `"network": ["discord.com"]` and `"readMessages": true` |
| `api.rest` to post, edit, or delete messages, or to use interactions, webhooks, or new threads | `"network": ["discord.com"]` and `"sendMessages": true` |
| `api.rest` to change your account, profile, or settings (`/users/@me...`) | `"network": ["discord.com"]` and `"changeSettings": true` |
| `api.settings.update`, `api.status.set` | `"network": ["discord.com"]` and `"changeSettings": true` |
| `api.rest` on any other endpoint | `"network": ["discord.com"]` |
| `accounts`, `whenConnected`, `api.status.get`, `navigate`, `avatarUrl`, `copy`, `format`, `parseMessageLink`, `chat` | Nothing |

`api.rest` and `api.messages` send requests through Discord's own API client, not the plugin's `fetch`, so Evi's guard doesn't see them. mist holds them to the plugin's declaration by the rules Evi applies to the plugin's own `fetch`:

- A plugin whose manifest has no `permissions` isn't held to anything, as in Evi.
- Every request needs `network` to cover `discord.com`. A listed host covers its subdomains.
- A `POST`, `PUT`, `PATCH`, or `DELETE` to a message, thread, interaction, or webhook endpoint needs `sendMessages`.
- A `POST`, `PUT`, `PATCH`, or `DELETE` to `/users/@me`, its settings, profile, consent, or connections needs `changeSettings`.
- `api.settings.update` and `api.status.set` save through Discord's settings updater, which sends `PATCH /users/@me/settings-proto/<type>`, so they need what that request needs: `network` and `changeSettings`.
- `api.messages` needs `readMessages`. Evi doesn't check `readMessages` for a `GET`, so mist doesn't check it for `api.rest.get` either. Declare it anyway.

mist reads the path as Discord's API does. It decodes `%`-escapes, so `/users/%40me` is `/users/@me`, and it drops repeated and trailing slashes, the query, and the fragment. A path it can't decode needs every flag. mist reads the declaration from `Evi.plugins` at each request, so it follows an update.

An id Evi has no loaded plugin by throws an `UnknownPluginError` at each request, before anything is sent, so a made-up id doesn't count as a plugin that declares nothing. A refused request throws a `PluginPermissionError` before anything is sent. Its `permission` names what to declare, and its `message` matches Evi's, as in `example can't send messages (discord.com): its manifest doesn't declare permissions.sendMessages`.

These checks mirror Evi's guard. They catch what an honest plugin forgot to declare. They don't make the declaration a sandbox, because plugin code can reach Discord's client in other ways. Store reviewers still read the code and compare the declaration with what it does, and the store shows the declaration to users.

Some parts need nothing in `permissions` but still show on the plugin's store page and in its review:

- `copy` writes to the clipboard. The store lists clipboard use, and the review notes `DiscordNative.clipboard`.
- `accounts.switchTo` changes the account Discord is signed in to, and `accounts.openLogin` opens Discord's login for another account. Say so in the plugin's description.
- `chat.localMessage` uses Discord's message actions to show a message that only you see. It sends nothing.

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

`MultiAccountStore.getUsers()` has given an array in some Discord builds and an object keyed by id in others, so `list` reads both. It drops an entry without an id and a second entry with the same id. A missing `username` becomes the id, and a missing `discriminator` becomes `"0"`, which is what accounts with the new usernames have. `status` is `"invalid"` when Discord will ask for the account's password again. A status that Discord adds later counts as `"valid"`.

Each entry copies only the fields above. The store's entries also hold a push token, and `list` never copies it.

```ts
const others = accounts.list().filter(a => a.id !== accounts.current() && a.status !== "invalid");
```

### accounts.current

```ts
accounts.current(): string | undefined;
```

The id of the account Discord is signed in to. During a switch, Discord's `UserStore` has no current user until the new account connects. In that time, `current` gives the id of the account Discord is switching to, which it reads from Discord's `MultiAccountSwitchStore`. It gives `undefined` when you are logged out and before Discord has connected.

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

- `switching`: a switch began. `from` is the account it leaves and `to` is the account it goes to. `to` is `undefined` when Discord logged out to switch without saying first where to.
- `connected`: Discord connected as `id`. After a switch, `from` is the account the switch left. When this connection wasn't a switch, such as a reconnect after the network dropped or the first connection after start, `from` is `undefined`. When a switch fails, Discord connects as the account it left, so `id` equals `from`.
- `signedOut`: you logged out, and not to switch. `id` is the account that was signed in, when it is known.

```ts
start(ctx) {
	ctx.onDispose(accounts.on("switching", () => cache.clear()));
	ctx.onDispose(accounts.on("connected", ({ id, from }) => {
		if (from && from !== id) mist.log.info(`switched from ${from} to ${id}`);
	}));
},
```

The events come from Discord's `MULTI_ACCOUNT_SWITCH_START`, `LOGOUT`, and `CONNECTION_OPEN` actions. One switch gives one `switching`, whichever of the first two actions comes first. A listener that throws doesn't stop the other listeners or Discord's own handlers. The error goes to `reportError`, which prints it in DevTools.

A plugin that starts during a switch takes the switch from Discord's `MultiAccountSwitchStore`, so the `connected` that ends the switch has `from` set to `undefined`.

### accounts.switchTo

```ts
type SwitchResult = "switched" | "already" | "needsLogin" | "failed";

accounts.switchTo(id: string, options?: { synchronously?: boolean; }): Promise<SwitchResult>;
```

Switches to a saved account with Discord's own switch function, the one Discord's Switch Accounts menu calls, and says what Discord answered:

| Result | Means |
| --- | --- |
| `"switched"` | Discord took the account's saved login. |
| `"already"` | Discord is signed in to `id` already. Nothing was called. |
| `"needsLogin"` | Discord has no login saved for the account, as after it was signed out elsewhere. Call `accounts.openLogin()` to let the user sign in. |
| `"failed"` | Discord refused the login, or its switch threw. |

`synchronously` is passed to Discord as its own `switchSynchronously` argument. Left out, Discord does what its menu does. It throws a `TypeError` when `id` isn't a Discord id, and an `Error` when Discord's switch function can't be found.

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

Opens Discord's own login for adding an account, the one its Switch Accounts menu opens with Add an Account. Its back button goes to Discord's Switch Accounts list. It returns `false` when Discord's function can't be found.

### accounts.scope

```ts
type AccountRun = (accountId: string, signal: AbortSignal) => void | (() => void) | Promise<void | (() => void)>;

accounts.scope(run: AccountRun, options?: { settleMs?: number; }): () => void;
```

Runs work for one account at a time, for plugins that keep per-account state, timers, or listeners. It calls `run(accountId, signal)` for the account Discord is connected as: at once when Discord is connected already, and otherwise when it connects. When the account switches or signs out, `signal` aborts and the cleanup function that `run` returned is called. When Discord connects as the next account, `run` is called again for it. A reconnection to the same account doesn't run it again.

`settleMs` (default 0) waits that long after a connection before `run`, because Discord fills many stores a moment after it connects. It isn't waited when Discord is connected already. A switch during the wait cancels the run.

`run` can be async and resolve with its cleanup. A cleanup that arrives after the account left is called at once. An error that `run` or its cleanup throws, or a rejection, goes to `reportError`, so it shows in the console and isn't thrown into Discord's dispatch. The function `scope` returns stops it and ends the current run, so pass it to `ctx.onDispose`.

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

Resolves with the account id once Discord is connected. If Discord is already connected, it resolves at once. During a switch, it waits for the new account. With a `signal`, it rejects with `signal.reason` when the signal aborts, and stops listening.

```ts
async start(ctx) {
	const stopped = new AbortController();
	ctx.onDispose(() => stopped.abort());
	const id = await whenConnected(stopped.signal);
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

Sends a request to Discord's API with Discord's own API client, as the account that is signed in. The client adds the login, the API version, and Discord's headers. It also holds back a request to a path that answered 429 until the wait is over. The plugin never sees the login.

`path` is the path after `/api/v<n>`, such as `/users/@me` or `/channels/123/messages`. A path that doesn't start with exactly one `/` throws a `TypeError` before anything is sent, because Discord's client would sign a full URL to another site too. A request the manifest doesn't declare throws a `PluginPermissionError`, also before anything is sent.

The result is the parsed body of a 2xx answer, or `undefined` when there is none. It is `unknown` on purpose, so check it before use.

| Option | Effect |
| --- | --- |
| `query` | Added to the URL. A `null` or `undefined` value is left out. |
| `body` | Sent as JSON. |
| `headers` | Added to Discord's headers. |
| `reason` | Sent as `X-Audit-Log-Reason`, which a server's audit log shows for moderation actions. |
| `signal` | Aborts the request. The promise then rejects with `signal.reason`. |

```ts
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

What `api.rest` and `api.messages` throw for a request the plugin's manifest doesn't declare, before anything is sent. `name` is `"PluginPermissionError"`, as for Evi's own refusals. `target` is `discord.com` for a request, and the channel's messages path for `api.messages`.

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

`before` and `after` can't both be given. TypeScript refuses it, and at run time it throws a `TypeError`. `limit` is the number of messages in all, a finite number from 0, and the default is every message there is. It asks for no more messages than `limit` needs.

`api.messages` checks its arguments and the plugin's permissions when you call it, before the loop starts. A bad channel or message id, `before` with `after`, a `limit` that is negative or not finite, and a missing `readMessages` throw there, not at the first `next()`.

It stops at the end of the channel, at `limit`, or when you `break` out of the loop. When Discord answers 429, it waits the `retryAfter` that Discord gives and asks for the same page again, up to 5 times in a row. Any other error is thrown as a `DiscordApiError`. With a `signal`, it stops when the signal aborts, also during a wait, and throws `signal.reason`.

The fields in `ApiMessage` are checked. An entry that doesn't have them is skipped. The other fields are as Discord's API sends them, in snake case, so check them before use.

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

api.settings.update(proto: SettingsProto, group: string, change: (value: any) => boolean | void, options?: { timeoutMs?: number; }): Promise<SaveResult>;
```

Changes the signed-in account's synced settings with Discord's own settings updater, the code Discord's settings pages use, and waits for Discord to confirm that the account saved them. Discord keeps these settings in two protos: `"preloaded"` has most settings, such as `status`, `appearance`, and `privacy`, and `"frecency"` has favourites and recents, such as `favoriteGifs` and `favoriteEmojis`. `group` names one field of the proto, and `change` gets that group's value to edit in place. Its fields are in camel case, as Discord's generated proto code names them.

- When `change` returns `false`, nothing changed: nothing is saved, and the result is `"unchanged"`.
- Otherwise Discord saves the change at once, as after a click. The result is `"saved"` once Discord dispatches `USER_SETTINGS_PROTO_UPDATE` with `wasSaved` for that proto.
- The result is `"failed"` when Discord's updater can't be found, reports an error, or doesn't confirm within `timeoutMs` (30000 by default). After a failure it reloads the proto from Discord, so the change isn't kept on this device and saved later.

A proto that isn't one of the two, an empty `group`, or a `change` that isn't a function throws a `TypeError`. It needs `changeSettings`; see [Permissions](#permissions). It writes only to the account Discord is signed in to.

```ts
const result = await api.settings.update("frecency", "favoriteEmojis", value => {
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

The signed-in account's custom status. `get` reads it from Discord's `UserSettingsProtoStore`, and gives `null` when there is none, or before Discord has loaded the account's settings. `emojiName` is a Unicode emoji or a custom emoji's name, `emojiId` is a custom emoji's id, and `expiresAt` is when the status ends, in milliseconds since 1970. Each is left out when the status has none.

`set` writes a new status with `api.settings.update`, built as Discord's own proto type, or clears it with `null`. It answers `"unchanged"` without saving when the status is already the same. A status needs text, an emoji, or both. Text over 128 characters, an `emojiId` that isn't a Discord id, or an `expiresAt` that isn't a time throws a `TypeError`. It needs `changeSettings`.

```ts
const before = api.status.get();
await api.status.set({ text: "Raining in Lisbon", emojiName: "🌧️", expiresAt: Date.now() + 60 * 60_000 });
// Later
await api.status.set(before);
```

## navigate

```ts
function navigate(path: string): void;
```

Opens a page of Discord's app with Discord's own router, as clicking a link in Discord does. `path` is a path in the app, such as `/channels/@me`, `/channels/<server>/<channel>`, or `/channels/<server>/<channel>/<message>` to jump to a message. A path that doesn't start with exactly one `/` throws a `TypeError`. It throws an `Error` when Discord's router can't be found.

```ts
navigate(`/channels/${guildId ?? "@me"}/${channelId}/${messageId}`);
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

`size` is in pixels, and the default is 128. The CDN serves powers of two from 16 to 4096, so `avatarUrl` rounds `size` up to the next one.

When the user has no avatar of their own, the result is Discord's default avatar for them. Discord picks one of six from the id for accounts with the new usernames, and one of five from the tag for legacy tags such as `name#1234`.

```tsx
<img src={avatarUrl(account, 32)} width={32} height={32} alt="" />
```

The image loads through Discord's page, not the plugin's `fetch`, so it needs no `network` permission.

## copy

```ts
function copy(text: string): Promise<void>;
```

Puts `text` on the clipboard. In Discord's desktop app it uses `DiscordNative.clipboard.copy`, and in a browser it uses `navigator.clipboard.writeText`.

```ts
await copy(message.id);
```

The `DiscordNative` property access and the `clipboard.writeText` call are written out in `copy` itself, not in a helper. Evi's store review and the store's capability list find these uses by searching the plugin's bundle for them, so a plugin that imports `copy` shows its clipboard use as if it had written the code itself. [Util](util.md#discordnative-types) explains why mist-api has no general `DiscordNative` accessor.

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

Times and dates in Discord's language, the one picked in Discord's Language settings. `toLocaleString()` and `Intl` without a locale use the system's language instead, which can be another language. Each function reads the language when it is called, so it follows a change in Discord's settings. It reads the language from Evi's `I18n.discordLocale`. Formatters are kept per language and options, because making one costs far more than using it.

| Function | Gives | Examples in English |
| --- | --- | --- |
| `locale()` | Discord's language tag | `"en-US"`, `"pt-BR"` |
| `clock(ms)` | A timer's reading. Hours show only when there are some. Below 0 counts as 0. | `"4:05"`, `"1:02:03"` |
| `duration(ms, options)` | A length of time in words, with the largest units that aren't 0 | `"1 hour, 2 minutes"`, `"1 day"` |
| `ago(at, now)` | The time from now to `at`, in the past or the future | `"5 minutes ago"`, `"yesterday"`, `"in 2 hours"`, `"now"` |
| `date(at, options)` | `at` as `Intl.DateTimeFormat` writes it with `options`. The default is `{ dateStyle: "medium" }`. | `"Nov 4, 2026"` |

`duration` shows `units` units, 2 by default, starting at the largest unit that isn't 0. A unit of 0 among them is left out, so 1 day and 5 minutes is `"1 day"`. `style` is `"long"` by default. `"short"` gives `"1 hr, 2 min"`. Below one second it gives `"0 seconds"`.

`ago` uses years, months, weeks, days, hours, and minutes, and says `"now"` for less than a minute either way. It rounds to the nearest whole unit and picks the unit after rounding, so 59 minutes 50 seconds is `"1 hour ago"`, not `"60 minutes ago"`. `now` defaults to `Date.now()`.

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
if (target?.messageId) navigate(`/channels/${target.guildId ?? "@me"}/${target.channelId}/${target.messageId}`);
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
