# Migrate a plugin to mist-api

This guide moves an existing Evi plugin onto mist-api, one change at a time. Each step leaves the plugin working: you can typecheck and run it between steps. The examples use Weather Bar, an invented plugin that shows the weather for a city. Its native side asks a weather service, and its page side shows the answer. The examples show only the lines that change.

Before you start, install mist-api into `userplugins/node_modules` as the [README](../README.md#install) shows.

## 1. Replace the module-level context with createMist

A plugin without mist-api keeps its context in a module-level variable and asserts it everywhere:

```ts
import { definePlugin } from "@evi/api";
import type { PluginContext } from "@evi/api";

let context: PluginContext<Settings> | undefined;

function units(): Units {
	return context!.settings.get("metric") ? "metric" : "imperial";
}

export default definePlugin({
	settings,
	start(ctx) {
		context = ctx;
		refresh().catch(() => { }).finally(() => { if (context === ctx && !timer) schedule(); });
		ctx.onDispose(() => {
			clearTimeout(timer);
			timer = undefined;
			context = undefined;
		});
	},
});
```

Create the plugin's `Mist` object once, wrap the definition with `mist.define`, and delete the variable:

```ts
import { createMist } from "@aurologic/mist-api";

import type native from "./native";

export const mist = createMist<typeof settings, typeof native>("weather-bar");

function units(): Units {
	return mist.ctx.settings.get("metric") ? "metric" : "imperial";
}

export default mist.define({
	settings,
	start(ctx) {
		refresh().catch(() => { }).finally(() => { if (mist.running && mist.ctx === ctx && !timer) schedule(); });
		ctx.onDispose(() => {
			clearTimeout(timer);
			timer = undefined;
		});
	},
});
```

Then change each use of the variable:

| Before | After |
| --- | --- |
| `context!.x` | `mist.ctx.x` |
| `if (!context) return;` | `if (!mist.running) return;` |
| `context?.x` used only to skip when stopped | `if (mist.running) mist.ctx.x` |
| `context === ctx` | `mist.running && mist.ctx === ctx` |
| `context?.toast(...)` | `mist.toast(...)` |
| An `AbortController` aborted in `onDispose` | `const signal = mist.signal;` in `start` |
| `context = ctx` in `start` | Delete it. |
| `context = undefined` in `onDispose` | Delete it. |

`mist.ctx` throws, naming the plugin, when the plugin isn't running. A missed `!` fails with `weather-bar isn't running` instead of `Cannot read properties of undefined`.

Pass the id from `manifest.json` to `createMist`. Step 2 covers secrets in recorded arguments.

## 2. Type native calls with defineNative

A plugin without mist-api calls native methods by name, with the result type written at each call:

```ts
// index.tsx
const forecast = await context!.native.call<Forecast | null>("forecast", city, units(), { apiKey: context!.settings.get("apiKey") });
```

```ts
// native.ts
import type { NativePlugin } from "@evi/api/native";

export default {
	stop: closeAll,
	async forecast(rawCity: unknown, rawUnits: unknown, rawKeys: unknown) {
		const city = parseCity(rawCity);
		// ...
	},
	openRadar,
} satisfies NativePlugin;
```

Nothing checks that `"forecast"` exists, that the arguments match, or that `Forecast | null` is what it returns.

To type the calls:

1. In `native.ts`, wrap the module in `defineNative` in place of `satisfies NativePlugin`:

	```ts
	import { defineNative } from "@aurologic/mist-api/native";

	export default defineNative({
		stop: closeAll,

		async forecast(rawCity: string, rawUnits: Units, rawKeys: { apiKey: string; }): Promise<Forecast | null> {
			const city = parseCity(rawCity);
			const units = rawUnits === "imperial" ? "imperial" : "metric";
			const key = isRecord(rawKeys) && typeof rawKeys.apiKey === "string" ? rawKeys.apiKey : "";
			return fetchForecast(city, units, key);
		},

		openRadar,
	});
	```

2. Give each parameter the type the page should send. With `unknown` parameters, the page side accepts any argument. Keep the validation inside the method. The type tells the page what to send, but nothing checks it across IPC, and page code is untrusted.

3. Give each method an explicit return type where the inferred one is wider than you want. The page's result type comes from it.

4. In `index.tsx`, pass `typeof native` to `createMist`, as in step 1, and call methods on `mist.native`:

	```ts
	const forecast = await mist.native.forecast(city, units(), { apiKey: mist.ctx.settings.get("apiKey") });
	if (await mist.native.openRadar(city)) refreshSoon();
	```

5. Run the typecheck. Every call with a wrong name or wrong arguments is now an error.

`import type native from "./native"` brings in only the type. None of the native code goes into the page bundle.

### Mask secrets in arguments

mist-api records each native call's arguments for `mist calls` and `mist native-logs`. With Discord's debugging port on, the CLI shows them whole. Fields named like secrets are masked, such as `token`, `password`, `cookie`, and `session`. [createMist](core.md#mistoptions) lists the full set.

Name the field that carries a secret so a built-in name matches it. Weather Bar sends its key as `apiKey`, which matches the built-in `api_key` name. It is masked on both sides with no options. The setting of the same name is masked in `mist values` for the same reason.

When a field name can't change, add it to `secrets` on both sides, because the page side and the native side record separately:

```ts
// index.tsx
export const mist = createMist<typeof settings, typeof native>("weather-bar", { secrets: ["licenseKey"] });
```

```ts
// native.ts
export default defineNative({ /* ... */ }, { secrets: ["licenseKey"] });
```

Masking goes by name: an object field's name, or a `Map` entry's string key. A bare string can't be recognized as a secret. If a method takes a secret as a bare string, as in `login(key: string)`, change it to take an object, as in `login(keys: { apiKey: string })`. If its signature can't change, because it is a port of another client's code, mask the argument by position on both sides, as in `{ secretArgs: { login: [0] } }`.

## 3. Replace ctx.logger with mist.log

Before:

```ts
try {
	forecast = await context!.native.call<Forecast | null>("forecast", city, units(), keys);
} catch (err) {
	context?.logger.warn("Couldn't get the forecast", err);
}
```

After:

```ts
try {
	forecast = await mist.native.forecast(city, units(), keys);
} catch (err) {
	mist.log.warn("Couldn't get the forecast", err);
}
```

`mist.log` prints through `ctx.logger` while the plugin runs and records every line for `mist logs`. A line written while the plugin is stopped is recorded but not printed. `context?.logger` drops such a line without a trace.

In `native.ts`, replace `console.log`, `console.warn`, and `console.error` with `log` from `@aurologic/mist-api/native`. Native console output goes only to main's stdout, which the CLI can't read. `log` lines also go into the ring that `mist native-logs` reads:

```ts
import { log } from "@aurologic/mist-api/native";

log.warn("The weather service answered late");
```

A `log` line written before `defineNative` runs, such as one at module load, is held and recorded once `defineNative` runs, with its options. [defineNative](native.md#the-native-ring) has the details.

## 4. Replace hand-written store hooks and interfaces

Plugins often carry hand-written store types and a store hook:

```ts
interface FluxStore {
	addChangeListener(listener: () => void): void;
	removeChangeListener(listener: () => void): void;
}

function useStoreValue<T>(store: FluxStore | undefined, get: () => T): T {
	return React.useSyncExternalStore(listener => {
		store?.addChangeListener(listener);
		return () => store?.removeChangeListener(listener);
	}, get);
}

const currentUserId = (): string | undefined => findStore("UserStore")?.getCurrentUser?.()?.id;
```

Import them from `@aurologic/mist-api/stores` instead:

```ts
import { currentUserId, type FluxStore, stores, useStore } from "@aurologic/mist-api/stores";

function Account() {
	const me = useStore(stores.user, () => stores.user?.getCurrentUser?.()?.username);
	return <span>{me ?? currentUserId() ?? "Nobody"}</span>;
}
```

`useStore` differs from a hand-written `useSyncExternalStore` hook in two ways:

- It caches the getter's value until a store or a dep changes. A getter that returns a new object or array each time doesn't cause a render loop.
- It takes `deps`, like `useMemo`. If the getter reads a prop or state, list it, as in `useStore(stores.user, () => stores.user?.getUser(id), [id])`.

`stores` covers 14 common Discord stores ([Stores](stores.md#stores) lists them). For any other store, extend `FluxStore` and read it with `store`:

```ts
import { type FluxStore, store, useStore } from "@aurologic/mist-api/stores";

interface TypingStore extends FluxStore {
	getTypingUsers(channelId: string): Record<string, number>;
}

function Typing({ channelId }: { channelId: string; }) {
	const count = useStore("TypingStore", () => Object.keys(store<TypingStore>("TypingStore")?.getTypingUsers(channelId) ?? {}).length, [channelId]);
	return <span>{count} typing</span>;
}
```

## 5. Replace small helpers with @aurologic/mist-api/util

| Hand-written | @aurologic/mist-api/util |
| --- | --- |
| `typeof x === "object" && x !== null && !Array.isArray(x)` | `isRecord(x)` |
| `const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))` | `sleep(ms)`, or `sleep(ms, signal)` to stop early |
| `fetch(url, { signal: AbortSignal.timeout(15_000) })` | `fetchWithTimeout(url, { timeout: 15_000 })` |
| `if (!res.ok) throw new Error("HTTP " + res.status); return res.json();` | `fetchJson(url)`, which throws `HttpError` with the same message |
| `(window as any).DiscordNative` | `(window as WithDiscordNative).DiscordNative` (types only, see [Util](util.md#discordnative-types)) |
| `pending ??= load().finally(() => { pending = undefined; })` | `shared(load)`, or `sharedByKey` for one run per key |
| A retry loop that doubles its wait | `backoff()`, or `keepConnected(connect, { signal })` for a connection to keep up |
| Splitting an event stream's text on blank lines | `sseEvents(response, signal)` |
| A `Map` of `{ until, value }` entries trimmed by hand | `ttlCache({ ttlMs, max })` |
| A queue and a running count | `limit(n)` |

If `native.ts` defines a `sleep`, delete it and import `sleep` from `@aurologic/mist-api/util`.

`fetchWithTimeout` and `fetchJson` call the global `fetch`. In `native.ts`, keep Electron's `net.fetch` where you need Chromium's network stack or a session's cookies. A plain `fetch` without a timeout gets one from `fetchJson`.

`HttpError` keeps the `"HTTP <status>"` message. A check like `message === "HTTP 401"` on the error keeps working on the native side.

Read `DiscordNative` where you use the bridge. Don't keep it in a module-level constant, because Evi can load a plugin before Discord's preload exposes it. Keep the `DiscordNative.x` access in the plugin's code, where Evi's store review still lists what the plugin uses.

## 6. Replace Symbol.for buses with @aurologic/mist-api/bus

Plugins that talk to each other often share a set of listeners on `globalThis`:

```ts
const KEY = Symbol.for("weather-bar.current");
const listeners: Set<(forecast: Forecast) => void> = ((globalThis as any)[KEY] ??= new Set());

listeners.forEach(listener => listener(forecast));
```

Use a `channel` instead:

```ts
import { channel } from "@aurologic/mist-api/bus";

const current = channel<Forecast>("weather-bar.current", 1);
const off = current.subscribe(forecast => mist.log.info(forecast.summary));
current.publish(forecast);
off();
```

The version is part of the key. When the shape of `Forecast` changes, raise it to 2. Plugins that expect the first shape then never get the new one. A listener that throws doesn't stop the other listeners.

For one shared value, such as an API object that a plugin offers while it runs, use a `slot` and release it on stop. A late release from an old copy doesn't clear the value a newer copy set. [Bus](bus.md#slot) shows the pattern.

The bus keys its state as `mist-api.bus/channel/<name>@<version>`. A plugin that keeps a hand-made `Symbol.for` key doesn't hear the new channel. Move every plugin that shares a bus in the same change.

## 7. Replace a hand-written long poll with mist.events

A native side can't push to the page. A plugin that reports changes from main often has the page poll in a loop:

```ts
// index.tsx
let cursor = 0;
while (running) {
	const answer = await context!.native.call<{ cursor: number; alerts: Alert[]; }>("poll", cursor);
	cursor = answer.cursor;
	for (const alert of answer.alerts) show(alert);
}
```

Make an event channel in `native.ts`, pass it to `defineNative`, and delete the `poll` method:

```ts
// native.ts
import { defineNative, nativeEvents } from "@aurologic/mist-api/native";

const events = nativeEvents<Alert>({ keep: 200 });

export default defineNative({ /* ... */ }, { events });

// Wherever an alert comes in
events.push(alert);
```

Subscribe on the page, in `start`:

```ts
// index.tsx
mist.events.subscribe(alert => show(alert), { onConnect: refresh });
```

The subscription ends when the run is disposed. [Events](events.md) covers ordering, replay for a reloaded page, and restarts.

## Upgrade from mist-api 0.3 to 0.4

One call changed. `accounts.switchTo` resolved with nothing in 0.3, and now resolves with what Discord answered: `"switched"`, `"already"`, `"needsLogin"`, or `"failed"`. Code that ignores the result keeps working. One behaviour changed with it: a switch that Discord refused or that threw used to reject, and now resolves `"failed"`. Replace a `try`/`catch` around it with a check of the result:

```ts
// 0.3
try {
	await accounts.switchTo(id);
} catch {
	toast("Couldn't switch");
}

// 0.4
const result = await accounts.switchTo(id);
if (result === "needsLogin") accounts.openLogin();
else if (result === "failed") toast("Couldn't switch");
```

It still throws for an id that isn't a Discord id, and when Discord's switch function can't be found.

A hand-written module mock of `electron` in a native side's tests can move to `fakeElectron` from `@aurologic/mist-api/testing`. See [Testing](testing.md#mock-electron).

## Upgrade from mist-api 0.4 to 0.5

Most plugins need no change. Check the plugin for each of these:

| If the plugin | Then |
| --- | --- |
| Reads messages with `api.rest.get` (such as `/channels/<id>/messages` or `/pins`) or `POST /channels/<id>/post-data` | Declare `readMessages` in its manifest, or the call throws a `PluginPermissionError`. |
| Has a `privateSession` | Nothing. Its partition is now `persist:mist:<plugin id>:<name>`. The first call moves the old partition's cookies one at a time and the user stays signed in, as [Logins from before 0.5](toolkit.md#logins-from-before-05) describes. A test that reads `electron.sessions` by the old name needs the new one. |
| Runs a `.cmd` or `.bat` file with `run` or `lifetime().spawn` | It failed with `EINVAL` before and now throws `needs-shell`. Run `cmd.exe` with `["/d", "/s", "/c", file, ...args]`, as [run](toolkit.md#run) shows. |
| Pushes an event or sends a request with a function, a DOM node, or another value IPC can't copy | `push` and `request` now throw `unclonable` at once. Send plain data. |
| Compares the reason of `lifetime().signal` or `accounts.scope`'s signal with an `Error` | It is now a `DOMException` named `AbortError`. |
| Calls `api.rest` or `navigate` with a `.` or `..` path segment or a raw control character | Both now throw a `TypeError`. |
| Relies on a `beforeSend` or `beforeEdit` listener's changes when it throws or times out | Those changes are now dropped. Finish every change before the listener can fail. |
| Waits for `settings.update` to reload Discord's settings after a timeout | A timeout still resolves `"failed"`, and no longer reloads. Reload only if you need to. |
| Passes `mist` an option it doesn't know, in a script | `mist` now refuses it. Put `--` before an argument that starts with `-`. |
| Parses `mist status` or `mist calls` text output for `WARNING:` or `FAILED` | `mist status` now prints `concern:` and `mist calls` prints `failed`. |
| Reads `error` from `mist react --json` | Read `problem`. |
| Imports the `Channel` type from `@aurologic/mist-api/bus` | Import `BusChannel`. `channel()` returns the same object. |
| Matches the text of a bus error, such as `mist bus: bad name or version` | Bus errors are now a `TypeError` or `RangeError` that start with `channel:` or `slot:`. [Bus](bus.md#how-copies-share-state) lists them. |
| Parses `mist` output with `--json` and reads errors from stderr | With `--json`, an error is `{"error": "..."}` on stdout. |

`discord(mist)` and the UI registries now work at module level, right after `createMist`. A plugin that called them in `start` only to wait for `mist.define` can move them up. Code that guards a toast or a settings read with `mist.running &&` can use `mist.toast` and `mist.settings`, which are safe between runs. [Core](core.md#mistsettings) describes them.

## Check the migration

1. Run the typecheck in your Evi checkout.
2. Run `bun run dev` and turn the plugin on.
3. Restart Discord with `mist restart`.
4. Run `mist status`. The plugin should show `running` and `native: mist (debug open)`.
5. Run `mist calls <id>` and `mist native-logs <id>`, and check that secrets show as `"[secret]"`.
