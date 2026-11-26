# mist-api

mist-api is a TypeScript library for anyone who writes [Evi](https://github.com/BleedDev/evi) plugins. It adds to Evi's plugin API in these ways:

- **Typed native calls.** `await mist.native.forecast(place)` takes its types from `native.ts`, and a renamed method fails the typecheck. A `NativeError` thrown there reaches the page with its `code`, and a call can be cancelled.
- **Events and requests from main.** The native side pushes events to the page with `nativeEvents`, and asks the page questions with `nativeRequests`.
- **A native toolkit.** Child processes and timers that stop with the plugin, atomic JSON files, encrypted secrets, file dialog grants, argument guards, and private login sessions.
- **The plugin's run, held for you.** `mist.ctx`, `mist.running`, and `mist.signal` replace a module-level `let context`. `mist.settings`, `mist.data`, `mist.flux`, and `mist.toast` are safe to call between runs.
- **Discord's app and UI.** Typed stores, Discord's API client held to the manifest's permissions, navigation, ids, display names, chat bar and hover bar buttons, message listeners, and settings pieces that look like Discord's.
- **A debugging CLI.** `mist` reads each plugin's logs, native calls, errors, patches, and Flux traffic over Discord's debugging port. [CLI](docs/cli.md) lists every command.
- **Test doubles.** A fake plugin context, Flux store, `@evi/api`, and `electron` for unit tests without Discord.

## Quick reference

Each subpath is `@aurologic/mist-api/<name>`. [Documentation](#documentation) links every page.

### The plugin and its native side

| I want to | Use |
| --- | --- |
| Call a method in Discord's main process | `defineNative({ ... })` in `native.ts`, then `await mist.native.forecast(place)` ([defineNative](docs/native.md)) |
| Push events from main to the page | `nativeEvents<E>()` in `native.ts`, then `mist.events.subscribe(listener)` ([Events](docs/events.md)) |
| Ask the page a question from main | `nativeRequests<R>()` in `native.ts`, then `mist.requests.handle(name, handler)` |
| Read or change a setting, even between runs | `mist.settings.get("key")`, `mist.settings.set("key", value)`, or `mist.settings.use("key")` in a component |
| Keep a plugin value across restarts | `mist.data("key", initial)`, with `get`, `set`, `update`, `onChange`, and `use()` |
| React to a Flux action, or wait for one | `mist.flux.on("MESSAGE_CREATE", handler)` or `await mist.flux.next("CHANNEL_SELECT", { timeout })` |
| Keep a patch callback from throwing into Discord's code | `mist.safe(fn, fallback)` |
| Keep a JSON file in main | `jsonFile(ctx, "state", { initial })` from `/native` |
| Write a file in main without leaving half of one | `await writeAtomic(path, content)` or `writeAtomicSync(path, content)` from `/native` |
| Store a token encrypted in main | `secrets(ctx).set("token", value)` from `/native` |

### Discord's app and UI

| I want to | Use |
| --- | --- |
| Re-render a component when a store changes | `useStore("SelectedChannelStore", () => ...)` from `/stores` |
| Read a Flux store that has no typed getter | `store<T>("StoreName")` from `/stores` |
| Wait for a store Discord makes late | `await whenStore("StoreName", { signal: mist.signal, timeout: 10_000 })` from `/stores` |
| Open a channel or a message | `navigate.channel(channelId, { messageId })` from `/discord` |
| Show the name Discord shows for a user | `displayName(user, { guildId })` from `/discord` |
| Check a Discord id, or read its time | `snowflake.is(value)`, `snowflake.assert(value, "what")`, or `snowflake.time(id)` from `/discord` |
| Show a date, a duration, or "5 minutes ago" | `format.date`, `format.duration`, `format.ago` from `/discord` |
| Add a button to the chat bar or to a message's hover bar | `chatBar.add(mist, id, Component)` or `popover.add(mist, id, Component)` from `/ui` |
| Share state between parts of the plugin's UI | `state(initial)`, then `value.use()` in a component, from `/ui` |
| Add a toggle or a labelled text field to settings | `Switch` and `TextInput` (`label`, `description`) from `/ui` |

### Timing and tests

| I want to | Use |
| --- | --- |
| Run something once input settles, or once per frame | `debounce(fn, 300)` or `debounce(fn, "frame")` from `/util` |
| Give up on a promise after a while | `withTimeout(work, ms, { signal })` from `/util` |
| Wait until a condition holds | `await until(() => check(), { timeout })` from `/util` |
| Unit-test a plugin without Discord | `fakeEvi()` as the `@evi/api` mock and `fakeContext({ id, evi })` from `/testing` |

## Install

mist-api goes where Evi's build finds it, in `<evi>/userplugins/node_modules`. Evi's build only builds folders under `userplugins` that have a `manifest.json`. It never builds `userplugins/node_modules` as a plugin.

Evi's build bundles everything a plugin imports except `@evi/api`, React, and `electron`, and each plugin carries a copy of mist-api. State that plugins share, such as the debug registry and the bus, lives on `globalThis` under versioned `Symbol.for` keys. Copies of different versions work together.

### From npm

Install the package in `<evi>/userplugins`. This makes a `package.json` and a `node_modules` there if they don't exist yet:

```sh
cd <evi>/userplugins
npm install @aurologic/mist-api
```

`bun add @aurologic/mist-api` works too.

### Types for @evi/api

mist-api's types refer to `@evi/api`, which isn't on npm. It is a peer dependency marked optional, and npm doesn't try to install it. Evi's build provides it when it bundles a plugin, and Evi's `tsconfig.json` provides its types by mapping `@evi/api` to Evi's sources.

A plugin under `<evi>/userplugins` needs no setup, because Evi's `tsconfig.json` covers `userplugins`. A plugin kept in a separate repository needs the same mapping. Point its `tsconfig.json` at an Evi checkout:

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ESNext",
		"moduleResolution": "Bundler",
		"lib": ["ES2023", "DOM", "DOM.Iterable"],
		"jsx": "react-jsx",
		"strict": true,
		"skipLibCheck": true,
		"noEmit": true,
		"allowImportingTsExtensions": true,
		"resolveJsonModule": true,
		"paths": {
			"@evi/api": ["<evi>/src/api/index.ts"],
			"@evi/api/*": ["<evi>/src/api/*"],
			"@shared/*": ["<evi>/src/shared/*"]
		}
	},
	"include": ["**/*.ts", "**/*.tsx", "<evi>/src/shared/globals.d.ts"]
}
```

`globals.d.ts` declares the globals and the `.css` imports that Evi's sources use. Without it, the typecheck fails inside Evi's files.

### From a local checkout

To work on mist-api and a plugin together, link the checkout into your Evi checkout. The package loads from `dist/`: build the checkout first, and again after each change. [Develop mist-api](#develop-mist-api) lists the commands. On Windows, run this in `cmd`:

```bat
mkdir <evi>\userplugins\node_modules\@aurologic
mklink /J <evi>\userplugins\node_modules\@aurologic\mist-api <path to mist-api>
```

On macOS and Linux:

```sh
mkdir -p <evi>/userplugins/node_modules/@aurologic
ln -s <path to mist-api> <evi>/userplugins/node_modules/@aurologic/mist-api
```

A git dependency such as `github:InfiniteCod3/mist-api` doesn't work, because `dist/` isn't in the repository. Install from npm to pin a version.

## For plugin authors

1. Install mist-api in `<evi>/userplugins`, as [Install](#install) shows.
2. Make a folder for the plugin in `<evi>/userplugins` with a `manifest.json` and an `index.tsx`. The `id` in `manifest.json` is the id you pass to `createMist`.
3. In `index.tsx`, call `createMist` once and export the result as `mist`. Export `mist.define({...})` as the default export, in place of `definePlugin`.
4. For a native side, write `native.ts` with `defineNative`. Pass `typeof native` to `createMist`, imported with `import type`.
5. Run `bun run dev` in your Evi checkout and turn the plugin on.
6. Start Discord with a debugging port with `npx -p @aurologic/mist-api mist restart`. Then read the plugin with `mist status`, `mist logs <id>`, and `mist calls <id>` the same way.
7. For bug reports from users, who can't run the CLI, offer `mist.copyReport()` in a settings panel button or `mist.reportCommand()` as a slash command. [mist.report](docs/core.md#mistreport) lists what the report contains.

The example below shows each file. [Migrate a plugin to mist-api](docs/migration.md) covers a plugin that already exists.

## Example

This plugin looks up the current temperature for a place in its native side and logs it. It takes three files in `<evi>/userplugins/weather-demo/`.

`native.ts` runs in Discord's main process. `defineNative` wraps the methods and returns the module:

```ts
import { defineNative } from "@aurologic/mist-api/native";
import { fetchJson, HttpError, isRecord } from "@aurologic/mist-api/util";

export interface Place {
	latitude: number;
	longitude: number;
}

export interface Forecast {
	temperature: number;
}

export default defineNative({
	async forecast(place: Place): Promise<Forecast | null> {
		// The page is untrusted: check the argument even though it is typed
		if (!isRecord(place) || typeof place.latitude !== "number" || typeof place.longitude !== "number") throw new Error("Bad place");
		const url = new URL("https://api.open-meteo.com/v1/forecast");
		url.searchParams.set("latitude", String(place.latitude));
		url.searchParams.set("longitude", String(place.longitude));
		url.searchParams.set("current", "temperature_2m");
		try {
			const body = await fetchJson(url, { timeout: 15_000 });
			const current = isRecord(body) ? body.current : undefined;
			return isRecord(current) && typeof current.temperature_2m === "number" ? { temperature: current.temperature_2m } : null;
		} catch (err) {
			if (err instanceof HttpError && err.status === 400) return null;
			throw err;
		}
	},
});
```

`index.tsx` runs in Discord's page. `import type` brings in the native module's type and none of its code:

```tsx
import type { SettingsSchema } from "@evi/api";
import { createMist } from "@aurologic/mist-api";

import type native from "./native";

const settings = {
	latitude: { type: "number", label: "Latitude", default: 52.52 },
	longitude: { type: "number", label: "Longitude", default: 13.41 },
} satisfies SettingsSchema;

export const mist = createMist<typeof settings, typeof native>("weather-demo");

export default mist.define({
	settings,
	async start(ctx) {
		const forecast = await mist.native.forecast({ latitude: ctx.settings.get("latitude"), longitude: ctx.settings.get("longitude") });
		mist.log.info(forecast ? `${forecast.temperature} °C` : "no forecast");
		mist.expose("forecast", () => forecast);
	},
});
```

`manifest.json` is an ordinary Evi manifest. The id passed to `createMist` must be the manifest's `id`, because the CLI finds plugins by that id. A plugin with a native side is full access, and its `permissions.network` lists the hosts that the native side contacts:

```json
{
	"id": "weather-demo",
	"name": "Weather Demo",
	"description": "Shows the current temperature for a place",
	"version": "1.0.0",
	"authors": ["you"],
	"permissions": { "network": ["api.open-meteo.com"] }
}
```

Run `bun run dev` in your Evi checkout and turn the plugin on. Evi's [plugin guide](https://github.com/BleedDev/evi/blob/main/docs/plugins.md) covers the manifest and the build.

## Use Discord's app

`@aurologic/mist-api/discord` covers the parts of Discord's app that plugins often rebuild:

- Saved accounts, account switches, per-account work, and Discord's login.
- The custom status and other settings writes.
- Discord's API client, with typed errors and message paging.
- Navigation, ids, display names, avatar URLs, and message links.
- The clipboard, the message box, and times and dates in Discord's language.

```ts
import { accounts, chat, discord, format } from "@aurologic/mist-api/discord";

const api = discord(mist);

export default mist.define({
	start(ctx) {
		ctx.onDispose(accounts.on("connected", ({ id }) => mist.log.info(`connected as ${id}`)));
	},
});

export async function showRecent(channelId: string) {
	const lines: string[] = [];
	for await (const message of api.messages(channelId, { limit: 200 })) {
		lines.push(`[${format.date(message.timestamp, { timeStyle: "short" })}] ${message.author.username}: ${message.content}`);
	}
	chat.localMessage(`Read ${lines.length} messages.`, channelId);
	return lines;
}
```

Reading messages through Discord's API needs `"network": ["discord.com"]` and `"readMessages": true` in the manifest's `permissions`, whether through `api.messages` or an `api.rest` call to a message-reading path. `discord(mist)` holds the plugin's requests to its declaration, by the same rules Evi applies to its `fetch`. It takes only the `mist` that `createMist` returned for the plugin, and one plugin can't use another's permissions by naming its id. [Which plugin is asking](docs/security.md#which-plugin-is-asking) says how far that check reaches. [Discord](docs/discord.md) lists what each part needs.

## Add UI inside Discord

`@aurologic/mist-api/ui` adds a plugin's UI to Discord's. It has buttons in the chat bar and in the hover bar of messages, UI under messages, and listeners that can change or stop a message before it is sent or edited. Plugins that bundle different copies of mist-api share each registry, and each entry goes when its plugin stops. Each entry renders inside an error boundary: UI that throws shows a small notice and leaves Discord's UI working. The subpath also has `state` and `useValue` for state that a plugin's UI shares, and `host` for a mount point that keeps working across hot reloads.

```tsx
import { chatBar, ChatBarButton, messages } from "@aurologic/mist-api/ui";

export default mist.define({
	patches: [...chatBar.patches, ...messages.patches],
	start() {
		chatBar.add(mist, "hello", ({ channel }) => (
			<ChatBarButton label="Say hello" onClick={() => mist.log.info("hello from", channel.id)}>Hi</ChatBarButton>
		));
		messages.beforeSend(mist, "no-shouting", draft => {
			if (draft.content === draft.content.toUpperCase()) return { cancel: true };
		});
	},
});
```

The registries need Discord code that mist-api patches. Spread their `patches` into the plugin's, and pass them the plugin's `mist`.

The hover bar, the UI under messages, and the send and edit listeners see message content. They need `"readMessages": true` in the manifest's `permissions`, or no `permissions` at all, as Evi asks of a plugin that hooks sending.

The settings pieces (`Button`, `Tip`, `Card`, `Row`, `Callout`, `Switch`, and `TextInput`) look like Discord's and keep working when Discord's component is missing. [UI](docs/ui.md) covers each part.

## Debug a plugin over CDP

The `mist` CLI talks to Discord over its debugging port. It runs on Node 22 or later. Run it with `npx -p @aurologic/mist-api mist`. Name the package with `-p`: a bare `npx mist` outside the install folder downloads an unrelated npm package called `mist`. The examples below write `mist` for that.

```sh
mist restart                    # restart Discord with --remote-debugging-port=9222
mist status                     # every mist plugin: state, version, native side, errors, patch health
mist logs weather-demo -f       # follow the plugin's page log
mist calls weather-demo         # native calls with arguments, results, and times
mist errors weather-demo -f     # page errors by plugin, source-mapped for watch builds
mist manifest fix --write       # fill missing translations and fit the 16 KB limit before an upload
```

Other commands read native logs, exposed values, Flux actions and stores, element layout, hot reloads, timings, patched modules, and React components, and call native methods. [CLI](docs/cli.md) lists every command and option.

The CLI shows the page's logs, calls, and values whole for every plugin. `mist call` works, and `mist native-logs` shows values whole, only when Discord's main process was started with a debugging port and the plugin's native side is made with `defineNative`. Other plugins on the page see only each value's type and size, log text and error messages included. Fields named like secrets (`token`, `password`, `cookie`, `session`, and others) are masked even in the whole view. [Security model](docs/security.md) explains why.

## Documentation

- [createMist](docs/core.md) is the page side of a plugin (`@aurologic/mist-api`).
- [defineNative](docs/native.md) is the main-process side (`@aurologic/mist-api/native`).
- [Events](docs/events.md) sends events from the native side to the page with `nativeEvents` and `mist.events.subscribe`.
- [Native toolkit](docs/toolkit.md) has `discordWindow`, `lifetime`, `run`, `which`, `dataFolder`, `jsonFile`, `writeAtomic`, `writeAtomicSync`, `secrets`, `pathGrants`, `check`, `privateSession`, `loginWindow`, and `openExternal`.
- [Stores](docs/stores.md) covers Discord's Flux stores, `store`, `whenStore`, `lookup`, `subscribe`, and `useStore` (`@aurologic/mist-api/stores`).
- [Util](docs/util.md) covers `isRecord`, `isSnowflake`, `sleep`, `fetchWithTimeout`, `fetchJson`, `HttpError`, `shared`, `backoff`, `keepConnected`, `sseEvents`, `ttlCache`, `limit`, `debounce`, `withTimeout`, `until`, and the `DiscordNative` types (`@aurologic/mist-api/util`).
- [Discord](docs/discord.md) covers accounts, Discord's API, settings and the custom status, navigation, ids and their times, display names, avatars, the clipboard, formatting in Discord's language, message links, and the message box (`@aurologic/mist-api/discord`).
- [Bus](docs/bus.md) covers channels and slots between plugins (`@aurologic/mist-api/bus`).
- [UI](docs/ui.md) covers the error boundary, `state`, `host`, the chat bar, hover bar, message accessory and message listener registries, and the settings pieces, `Switch` and `TextInput` among them (`@aurologic/mist-api/ui`).
- [Testing](docs/testing.md) covers the test doubles for a plugin's unit tests (`@aurologic/mist-api/testing`).
- [CLI](docs/cli.md) lists every `mist` command and flag.
- [Security model](docs/security.md) explains the debug gate and which plugin a permission check sees.
- [Migrate a plugin to mist-api](docs/migration.md) shows each change with before and after code.

## Develop mist-api

To typecheck, build, and test mist-api itself, it needs Evi's types. `scripts/setup.ts` points `.evi` at an Evi checkout, and links `node_modules/.evi` to the same checkout for the build. It uses `$EVI_DIR`, then a sibling `../evi`, and clones `BleedDev/evi` into `.evi` when it finds neither.

```sh
bun install
bun scripts/setup.ts
bun run typecheck
bun run build
bun test
bun scripts/check-pack.ts
bun scripts/check-install.ts
```

`bun run build` writes `dist/`. For each subpath it writes an ES module, a `.d.ts` file, and a source map, and it writes the CLI as `dist/bin/mist.js`.

- `scripts/check-pack.ts` checks what `npm pack` would publish. It fails if a file that `exports` or `bin` names is missing, or if `src`, `tests`, `scripts`, or `.evi` would ship.
- `scripts/check-install.ts` installs the packed tarball into a new project. It checks that `npx mist` runs, that a file importing every subpath typechecks with the tsconfig from [Types for @evi/api](#types-for-eviapi), and that a Bun bundle of a small plugin carries only what it imports.
- The CDP test also runs against `dist/` once it is built, and is skipped until then.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
