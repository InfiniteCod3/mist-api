# mist-api

mist-api is a TypeScript library for [Evi](https://github.com/BleedDev/evi) plugins. It adds to Evi's plugin API in these ways:

- Native calls are typed from the native module itself. `await mist.native.lookup(place)` gets its argument and result types from `native.ts`, so a renamed method or a changed argument fails the typecheck.
- The native side can send events to the page. Evi's native side can't push, so `mist.events.subscribe` long-polls a channel made with `nativeEvents`, in order, and loads the page's state again after a restart.
- Native calls keep their errors and can be cancelled. A `NativeError(code, data)` thrown in `native.ts` reaches the page as a `MistNativeError` with the same `code`, and `mist.native.method.with({ signal })` aborts the method's `this.signal`. Native code can also ask the page and wait for the answer with `nativeRequests` and `mist.requests.handle`.
- The native side has a toolkit: `discordWindow()`, a `lifetime(ctx)` scope that kills child processes and clears timers on stop, `run` and `which`, `jsonFile` with atomic writes flushed on stop, `secrets` with Electron's `safeStorage`, and `pathGrants`, file dialog handles that keep page input from naming paths.
- The plugin's context is held for you. `mist.ctx` is the running context and `mist.running` says whether there is one, so a plugin needs no module-level `let context` and no `context!`. `mist.signal` aborts when the run stops, and `mist.toast` does nothing after it, so timers and promise callbacks need no `mist.running` check.
- Common plugin code comes ready to use. That includes a Flux store hook, typed stores, `fetch` with a timeout, `sleep`, a bus between plugins, and `mist.storage`, a key-value store in IndexedDB for each plugin and, if you want, each account.
- `mist.define` checks the plugin's patches. A `$self` name in a patch that the definition has no function for is a warning in the log and in `mist status`, not a `TypeError` inside Discord's code.
- Plugins can be debugged over the Chrome DevTools Protocol (CDP). The `mist` CLI reads each plugin's logs, native calls, native logs, and exposed values, and calls native methods, while Discord runs with a debugging port. It also prints Flux actions as they are dispatched, reads Flux stores, and shows the layout of an element and the CSS rules that set it.
- Plugins can be unit tested without Discord. `@aurologic/mist-api/testing` has a fake plugin context, a fake Flux store, and a fake `@evi/api` module for any test runner's module mock.

It is a general library for anyone who writes Evi plugins. Evi's build bundles everything a plugin imports except `@evi/api`, React, and `electron`, so each plugin carries its own copy of mist-api. State that plugins share, such as the debug registry and the bus, lives on `globalThis` under versioned `Symbol.for` keys, so copies of different versions work together.

## Install

mist-api goes where Evi's build finds it, in `<evi>/userplugins/node_modules`. Evi's build only builds folders under `userplugins` that have a `manifest.json`, so `userplugins/node_modules` is never built as a plugin.

### From npm

Install the package in `<evi>/userplugins`. This makes a `package.json` and a `node_modules` there if they don't exist yet:

```sh
cd <evi>/userplugins
npm install @aurologic/mist-api
```

`bun add @aurologic/mist-api` works too.

### Types for @evi/api

mist-api's types refer to `@evi/api`, which isn't on npm. It is a peer dependency marked optional, so npm doesn't try to install it. Evi's build provides it when it bundles a plugin, and Evi's `tsconfig.json` provides its types by mapping `@evi/api` to Evi's own sources.

A plugin under `<evi>/userplugins` needs no setup, because Evi's `tsconfig.json` covers `userplugins`. A plugin kept in its own repository needs the same mapping. Point its `tsconfig.json` at an Evi checkout:

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

To work on mist-api and a plugin together, link the checkout into your Evi checkout. The package loads from `dist/`, so build the checkout first, and again after each change. [Develop mist-api](#develop-mist-api) lists the commands. On Windows, run this in `cmd`:

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
	async lookup(place: Place): Promise<Forecast | null> {
		// The page is untrusted, so check the argument even though it is typed
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
		const forecast = await mist.native.lookup({ latitude: ctx.settings.get("latitude"), longitude: ctx.settings.get("longitude") });
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

`@aurologic/mist-api/discord` covers the parts of Discord's app that plugins often rebuild: saved accounts and account switches, Discord's own API client with typed errors and message paging, Discord's router, avatar URLs, the clipboard, times and dates in Discord's language, and the message box.

```ts
import { accounts, chat, discord, format } from "@aurologic/mist-api/discord";

export async function showRecent(channelId: string) {
	const lines: string[] = [];
	for await (const message of discord.messages(channelId, { limit: 200 })) {
		lines.push(`[${format.date(message.timestamp, { timeStyle: "short" })}] ${message.author.username}: ${message.content}`);
	}
	chat.localMessage(`Read ${lines.length} messages.`, channelId);
	return lines;
}

export default mist.define({
	start(ctx) {
		ctx.onDispose(accounts.on("connected", ({ id }) => mist.log.info(`connected as ${id}`)));
	},
});
```

Reading messages through Discord's API needs `"network": ["discord.com"]` and `"readMessages": true` in the manifest's `permissions`. [Discord](docs/discord.md) lists what each part needs.

## Debug a plugin over CDP

The `mist` CLI talks to Discord over its debugging port. It runs on Node 22 or later. From npm, run it with `npx -p @aurologic/mist-api mist`, which works whether or not it's installed. Name the package with `-p`: a bare `npx mist` outside the install folder downloads an unrelated npm package called `mist`. From a checkout, run the built file, or run the source on Node 22.18 or later or on Bun:

```sh
npx -p @aurologic/mist-api mist <command>
node <path to mist-api>/dist/bin/mist.js <command>
bun <path to mist-api>/bin/mist.ts <command>
```

The examples below write `mist` for any of these.

1. Restart Discord with a debugging port:

	```sh
	mist restart
	```

	On Windows this force-closes `Discord.exe` and starts it again through `%LOCALAPPDATA%\Discord\Update.exe` with `--remote-debugging-port=9222`. On macOS and Linux it prints the command to run. `mist restart --dry-run` prints the Windows commands without running them.

2. List the plugins that use mist-api:

	```sh
	mist status
	```

	Each line shows whether the plugin runs, its mist-api version, its native side, whether the debug view is open, and its error counts. Under it are the plugin's patch and lookup health from Evi's own diagnostics.

3. Read and follow a plugin's page log:

	```sh
	mist logs weather-demo -f
	```

4. See its native calls, with arguments, result or error, and time taken:

	```sh
	mist calls weather-demo
	```

5. See what its native side logged and was called with. Native `console` output goes to Discord's main process stdout, which CDP can't see, so mist-api keeps it for this command:

	```sh
	mist native-logs weather-demo
	```

6. Read the values the plugin exposes, and its settings:

	```sh
	mist values weather-demo
	```

7. Call a native method. Each argument is JSON, or a plain string when it isn't valid JSON:

	```sh
	mist call weather-demo lookup '{"latitude":52.52,"longitude":13.41}'
	```

8. Read Evi's patch and lookup diagnosis, problems first:

	```sh
	mist patches weather-demo
	```

9. Watch the Flux actions that Discord dispatches, masked like recorded values, until Ctrl+C:

	```sh
	mist flux PRESENCE_UPDATES -f
	```

10. List a Flux store's methods, and call one that reads:

	```sh
	mist store SelectedChannelStore
	mist store SelectedChannelStore getChannelId
	```

11. See why an element is laid out the way it is, from its computed layout, its ancestors', and the CSS rules that set them:

	```sh
	mist inspect '[class^="sidebar_"]' --depth 2
	```

The CLI shows the page's logs, calls, and values whole for every plugin. `mist call` works, and `mist native-logs` shows values whole, only when Discord's main process was started with a debugging port and the plugin's native side is made with `defineNative`. Other plugins on the page see only each value's type and size, log text and error messages included. Fields named like secrets (`token`, `password`, `cookie`, `session`, and others) are masked even in the whole view. [Security model](docs/security.md) explains why.

## Documentation

- [createMist](docs/core.md) is the page side of a plugin (`@aurologic/mist-api`).
- [defineNative](docs/native.md) is the main-process side (`@aurologic/mist-api/native`).
- [Events](docs/events.md) sends events from the native side to the page with `nativeEvents` and `mist.events.subscribe`.
- [Native toolkit](docs/toolkit.md) has `discordWindow`, `lifetime`, `run`, `which`, `dataFolder`, `jsonFile`, `secrets`, and `pathGrants`.
- [Stores](docs/stores.md) covers Discord's Flux stores and `useStore` (`@aurologic/mist-api/stores`).
- [Util](docs/util.md) covers `isRecord`, `sleep`, `fetchWithTimeout`, `fetchJson`, `HttpError`, and the `DiscordNative` types (`@aurologic/mist-api/util`).
- [Discord](docs/discord.md) covers accounts, Discord's API, navigation, avatars, the clipboard, formatting in Discord's language, and the message box (`@aurologic/mist-api/discord`).
- [Bus](docs/bus.md) covers channels and slots between plugins (`@aurologic/mist-api/bus`).
- [Testing](docs/testing.md) covers the test doubles for a plugin's unit tests (`@aurologic/mist-api/testing`).
- [CLI](docs/cli.md) lists every `mist` command and flag.
- [Security model](docs/security.md) explains the debug gate.
- [Migrate a plugin to mist-api](docs/migration.md) shows each change with before and after code.

## Develop mist-api

To typecheck, build, and test mist-api itself, it needs Evi's types. `scripts/setup.ts` points `.evi` at an Evi checkout, and links `node_modules/.evi` to the same checkout for the build. It uses `$EVI_DIR`, then a sibling `../evi`, and clones `BleedDev/evi` into `.evi` when it finds neither.

```sh
bun install
bun scripts/setup.ts
bun run typecheck
bun run build
bun test
node scripts/check-pack.ts
bun scripts/check-install.ts
```

`bun run build` writes `dist/`. For each subpath it writes an ES module, a `.d.ts` file, and a source map, and it writes the CLI as `dist/bin/mist.js`. `scripts/check-pack.ts` checks what `npm pack` would publish. It fails if a file that `exports` or `bin` names is missing, or if `src`, `tests`, `scripts`, or `.evi` would ship. `scripts/check-install.ts` installs the packed tarball into a new project and checks that `npx mist` runs, that a file importing every subpath typechecks with the tsconfig from [Types for @evi/api](#types-for-eviapi), and that a Bun bundle of a small plugin carries only what it imports. The CDP test also runs against `dist/` once it is built, and is skipped until then.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
