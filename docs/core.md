# createMist

`@aurologic/mist-api` is the page side of a plugin. It exports `createMist`, `onDemand`, `MistNativeError`, the `MIST_VERSION` and `SETTINGS_VERSION` constants, and the types listed at the end of this page. `mist.events` is the page side of the [event channel](events.md).

```ts
import { createMist } from "@aurologic/mist-api";
```

## createMist

```ts
function createMist<S extends SettingsSchema = {}, N = {}>(id: string, options?: MistOptions<N>): Mist<S, N>;
```

Returns the plugin's `Mist` object. Call it once per plugin, at module level, and export the result for the plugin's other files.

- `S` is the plugin's settings schema, the same type that `definePlugin` takes. Pass `typeof settings`. Without it, `mist.ctx.settings.get` accepts no keys.
- `N` is the type of the native module. Pass `typeof native`, where `native` is the default export of `native.ts` imported with `import type`. Without it, `mist.native` has no methods.
- `id` is the plugin's id from `manifest.json`. Errors and the debug registry name the plugin by it. A run whose context has another id logs a warning.

```tsx
import type { SettingsSchema } from "@evi/api";
import { createMist } from "@aurologic/mist-api";

import type native from "./native";

const settings = {
	latitude: { type: "number", label: "Latitude", default: 52.52 },
	longitude: { type: "number", label: "Longitude", default: 13.41 },
} satisfies SettingsSchema;

export const mist = createMist<typeof settings, typeof native>("weather-demo");
```

### MistOptions

```ts
interface MistOptions<N> {
	secrets?: readonly string[];
	reveal?: readonly string[];
	secretArgs?: { [method in keyof NativeClient<N>]?: readonly number[] };
	quiet?: readonly (keyof NativeClient<N>)[];
	capacity?: number;
	provides?: Readonly<Record<string, number>>;
	needs?: readonly Need[];
}
```

| Option | Default | Effect |
| --- | --- | --- |
| `secrets` | `[]` | Field names and `Map` key names masked in recorded arguments, results, exposed values, and settings, on top of the built-in names. Each is a whole name, not a pattern. Matching ignores case. |
| `reveal` | `[]` | Field names and `Map` key names shown even though a built-in name would mask them, such as `sessionId` for an id that isn't a credential. Each is a whole name. Matching ignores case. A name in `secrets` stays masked. |
| `secretArgs` | `{}` | For each native method, the positions of arguments masked in its recorded calls, counting from 0. For a secret passed as a bare string. Only `N`'s methods can be named. |
| `quiet` | `[]` | Native methods whose calls are counted and not kept, such as a long poll that would push every other call out of the ring. A failed call is kept like any other. `HandleState.quiet` and `mist status` show the counts. Only `N`'s methods can be named. |
| `capacity` | `200` | How many native calls the page side keeps, and how many log lines. Each has a ring of this size. It must be a positive integer. |
| `provides` | `{}` | The bus protocols this plugin provides to other plugins, each with the version it speaks, as in `{ "weather-feed": 2 }`. Each version must be an integer of 1 or more, or `createMist` throws. See [Plugins that depend on each other](#plugins-that-depend-on-each-other). |
| `needs` | `[]` | The protocols this plugin speaks with other plugins: `{ plugin, protocol, version }` for each, where `plugin` is the other plugin's id. See [Plugins that depend on each other](#plugins-that-depend-on-each-other). |

The built-in names are every field or `Map` key whose name contains `token`, `secret`, `passw`, `cookie`, `authorization` or `authorisation`, `api_key` (or `apikey`, `api-key`), `credential`, or `session`. A masked field shows as `"[secret]"`. An empty or missing value isn't masked.

A token count isn't a token. A field whose name ends in `tokens` and whose value is a number is shown, as in `input_tokens`, `output_tokens`, or `maxTokens`. A string, an object, or an array under such a name is still masked, as is a number under `token` or `accessToken`.

Masking goes by name: an object field's name, or a `Map` entry's string key. Nothing names a bare string, and mist can't recognize it as a secret. A secret passed as a positional argument, as in `mist.native.login(key)`, or as an array item, shows whole in the open view. Pass it inside an object instead, as in `mist.native.login({ apiKey: key })`. When the signature can't change, name its position in `secretArgs`: a `login(user, code)` method that takes a one-time code second passes `{ secretArgs: { login: [1] } }`. A masked argument shows as `"[secret]"` whole and as `string(8)` reduced, which hides even its length.

The page side and the native side record separately. Give the same `secrets`, `reveal`, `secretArgs`, and `quiet` to `createMist` and to `defineNative`.

```ts
export const mist = createMist<typeof settings, typeof native>("weather-demo", { secrets: ["licenseKey"], capacity: 500 });
```

## Mist

```ts
interface Mist<S extends SettingsSchema, N> {
	readonly id: string;
	readonly ctx: PluginContext<S>;
	readonly running: boolean;
	readonly native: NativeClient<N>;
	readonly requests: MistRequests<RequestsOf<N>>;
	readonly log: MistLog;
	readonly events: MistEvents<EventsOf<N>>;
	readonly signal: AbortSignal;
	toast(message: ReactNode, options?: ToastOptions): void;
	readonly storage: PluginStorage;
	readonly settings: MistSettings<S>;
	data<T>(key: string, initial: T, options?: DataOptions<T>): MistData<T>;
	readonly flux: MistFlux;
	define(definition: MistDefinition<S>): DefinedPlugin<S>;
	report(): Promise<string>;
	copyReport(): Promise<boolean>;
	reportCommand(name?: string): CommandDefinition;
	expose(name: string, getter: () => unknown): void;
	safe<A extends unknown[], R>(fn: (...args: A) => R, fallback: (...args: A) => R, options?: SafeOptions): (...args: A) => R | undefined;
	safe<A extends unknown[], R>(fn: (...args: A) => R, fallback: R, options?: SafeOptions): (...args: A) => R;
}
```

### mist.define

```ts
define(definition: MistDefinition<S>): DefinedPlugin<S>;

type MistDefinition<S> = PluginDefinition<S> & { migrate?: readonly Migration<S>[] };
type DefinedPlugin<S> = PluginDefinition<S> & { start: NonNullable<PluginDefinition<S>["start"]> };
```

Wraps the plugin's definition. Use it in place of `definePlugin` and export its result as the default export.

The result is a copy of `definition` without `migrate`, with a wrapped `start`. `start` is always there, even when `definition` has none, and `DefinedPlugin<S>` types it as required: a test calls `definition.start(ctx)` without `!`.

Each time Evi calls `start`, the wrapper does these steps, in this order:

1. It points `mist.ctx` at the new context. When the context's id differs from the `id` given to `createMist`, it logs a warning.
2. It registers the plugin's handle again if another handle took its id in the debug registry while the plugin was stopped.
3. It aborts the previous run's [`mist.signal`](#mistsignal), if that run wasn't disposed, and makes a new one for this run.
4. It registers a dispose callback on the context. The callback clears `mist.ctx`, but only while this context is still the current one: a late dispose from an earlier run leaves a newer run alone. It then aborts this run's signal.
5. It asks the native side, without waiting, whether Discord's main process has a debugging port. The first answer is kept; a rejected call is asked again on the next debug request. [Security model](security.md#the-gate) explains this check.
6. It clears the previous run's warnings and lists the [`$self` names](#self-names) that the definition lacks.
7. It runs the [settings migrations](#settings-migrations) that the stored settings don't have yet.
8. It follows the context's settings for [`mist.settings`](#mistsettings), and tells the listeners of `mist.settings` and [`mist.data`](#mistdata) that the values may have changed, since between runs they read as defaults.
9. It calls your `start` with the same `this` and context, and watches the `stores` getters of [`@aurologic/mist-api/stores`](stores.md) until `start` returns or reaches its first `await`.
10. It checks the plugins in `needs`, as [Plugins that depend on each other](#plugins-that-depend-on-each-other) describes, and returns what your `start` returned.

```tsx
export default mist.define({
	settings,
	async start(ctx) {
		const forecast = await mist.native.forecast({ latitude: ctx.settings.get("latitude"), longitude: ctx.settings.get("longitude") });
		mist.log.info(forecast ? `${forecast.temperature} °C` : "no forecast");
	},
});
```

Evi runs `stop` before the context's dispose callbacks. `mist.ctx` and `mist.running` still work inside `stop`.

`createMist` registers the plugin in the page's debug registry when it is called, not at `define`. `discord(mist)` and the UI registries accept `mist` from then on. A new copy of the plugin, as after a hot reload, replaces the old copy's handle once the old run has stopped. [Security model](security.md#replacing-a-handle) explains the rules.

#### Stores read too early

Evi starts plugins as soon as Discord's React and Flux dispatcher exist, often before Discord has made stores such as `PresenceStore`. A `stores` getter read in `start` then gives `undefined`, and code such as `subscribe([stores.presence], redraw)` listens to nothing, with no error.

Each store that a getter reads as missing during `start` is a warning for the plugin. It names the store and the fix:

```text
start read PresenceStore before Discord made it and got undefined. Wait for it by name: subscribe(["PresenceStore"], …) or useStore("PresenceStore", …).
```

`mist.log.warn` prints it once per copy of the plugin, and `HandleState.warnings` lists it for each run in which it happens.

Only the synchronous part of `start` is watched. Evi calls the starts one after another, moving on when the previous one returns or reaches its first `await`. Until then only that plugin's code runs, and a missing store can be pinned on it. After an `await`, other plugins and Discord run too, and a miss can't be pinned on anyone. `findStore` from `@evi/api` isn't watched either. A store named to `subscribe` or `useStore` is never a warning: those wait for it.

#### $self names

Evi rewrites `$self` in a source patch's replacement into a reference to the plugin's definition. A misspelt name, as in `$self?.injectButon?.(e)`, gives `undefined` inside Discord's code. The patch does nothing, or a call without `?.` throws a `TypeError` in Discord's render, far from the patch.

`define` reads every string `with` in `patches` for `$self.name` and `$self?.name`, and checks each name against the definition it returns. Two cases are warnings: a name the definition doesn't have, and a name that is called, as in `$self.name(` or `$self?.name?.(`, without a function by that name. `mist.log.warn` prints each once per copy of the plugin. `HandleState.warnings` lists it for every run, and `mist status` and the debug report show it. When exactly one function of the definition is within two letters of the missing name, the warning suggests it:

```text
patches[1] calls $self.injectButon, but the definition has no function injectButon: Discord's code gets undefined there. Did you mean injectButton?
```

A `with` that is a function isn't checked: its text exists only when Evi calls it on a module's code. A name written another way, such as `$self["name"]`, isn't checked either.

#### Settings migrations

```ts
interface Migration<S> {
	readonly to: number;
	run(settings: MigrationSettings<S>): void;
}

interface MigrationSettings<S> {
	get(key: string): unknown;
	set<K extends keyof S & string>(key: K, value: SettingsValues<S>[K]): void;
}
```

When a new version of a plugin renames a setting or changes its shape, a migration moves the stored value. Evi saves and loads the plugin's whole settings entry as it is, including keys the schema no longer declares, and `ctx.settings.get` reads any stored key. A migration can therefore read the value under the old name and write it under the new one.

Each migration has a `to`, the settings version it makes. Versions are integers from 1. The wrapper stores the version the settings have reached under the key `__mist_settingsVersion` (exported as `SETTINGS_VERSION`). Settings without that key are at version 0.

Before each `start`, the wrapper runs every migration whose `to` is higher than the stored version, in order of `to`, and stores each `to` after its migration returns. A migration's writes and the new version reach Evi's settings in one synchronous step, and Evi saves them together. That is why `run` must be synchronous.

- `get` reads the stored value under any key. A declared key that was never set gives its default. Any other key that was never set gives `undefined`.
- `set` writes a declared key, with its type.
- A migration also runs for a user who installed the plugin after the change, whose settings hold no old values. Write each one to do nothing then: check that the old value exists and has the shape you expect.
- If a migration throws, the wrapper logs `Settings migration to <to> threw; it and later ones run again at the next start.` with the error through `mist.log.error`, and adds the line to `HandleState.warnings`. The plugin starts with its settings as they are. Writes made before the throw stay: write a migration that can run twice.
- `define` throws a `TypeError` if a `to` isn't a number, and a `RangeError` if it isn't an integer of 1 or more or if two migrations share a `to`.

```ts
export default mist.define({
	settings,
	migrate: [
		// 1.1 renamed `town` to `city`
		{ to: 1, run: s => { const town = s.get("town"); if (typeof town === "string") s.set("city", town); } },
		// 1.2 replaced the `fahrenheit` switch with the `units` select
		{ to: 2, run: s => { if (s.get("fahrenheit") === true) s.set("units", "imperial"); } },
	],
	start(ctx) { /* reads city and units */ },
});
```

The old values stay in the stored settings after a migration. Evi's settings UI lists only declared keys and doesn't show them.

To move a raw undeclared key into [`mist.data`](#mistdata), call the data object's `set` from the migration. `mist.ctx` already points at the run when migrations run, and the write is saved with the new version:

```ts
const dismissed = mist.data("dismissed", false);

export default mist.define({
	settings,
	migrate: [
		// 1.3 kept the notice flag as an undeclared settings key
		{ to: 3, run: s => { if (s.get("dismissedNotice") === true) dismissed.set(true); } },
	],
});
```

### mist.report

```ts
report(): Promise<string>;
```

A debug report that the plugin's user can paste into a bug report, for the many users who can't set up the CLI's debugging port. The report has:

- The plugin's id and version, the mist-api version, the Evi version, and Discord's release channel and build when the page shows them.
- The plugin's status, as `Mist.status()` gives it: running or stopped, the kind of native side, error counts, Evi's start error, `HandleState.warnings`, registry concerns, and patch and lookup problems.
- The last 50 page log lines and native calls. For a native side made with `defineNative`, also the last 50 log lines and calls on the native side.

It is built from the plugin's page-wide handle only. Every argument, result, log argument, and error message shows as its type and size, as in `string(28)`, and no value a plugin recorded appears in it. Evi's start error, patch errors from Evi, and mist-api's warnings appear whole.

### mist.copyReport

```ts
copyReport(): Promise<boolean>;
```

Copies the report to the clipboard and resolves to whether that worked. It uses `navigator.clipboard.writeText`. If that is refused, as when the page doesn't have focus, it copies from a hidden, selected `textarea` with `document.execCommand("copy")`. While the plugin runs, it shows a toast that says whether it copied.

Evi's settings schema has no button type. To offer the report in the plugin's settings, put a button in `settingsPanel`:

```tsx
import { Button } from "@aurologic/mist-api/ui";

export default mist.define({
	settings,
	settingsPanel: () => <Button onClick={() => void mist.copyReport()}>Copy debug report</Button>,
});
```

The `Button` from [`@aurologic/mist-api/ui`](ui.md#settings-pieces) renders Discord's button, and a styled plain button when Discord renamed it.

### mist.reportCommand

```ts
reportCommand(name?: string): CommandDefinition;
```

A slash command for `ctx.command` that copies the report and replies with a message only the user sees. If copying fails, the reply holds the report in a code block. The default name is the plugin id followed by `-report`, lowercased, with characters other than letters, digits, `-`, and `_` replaced by `-`, cut to 32 characters.

```ts
start(ctx) {
	ctx.command(mist.reportCommand());
},
```

A slash command gets the user a report even when the plugin's settings don't open.

### mist.ctx

```ts
readonly ctx: PluginContext<S>;
```

The plugin's context while it runs. Reading it between runs throws an `Error` that names the plugin:

```text
mist.ctx: weather-demo isn't running; the context exists from start until the run is disposed
```

### mist.running

```ts
readonly running: boolean;
```

`true` between `start` and the context's dispose. Check it before `mist.ctx` in code that can run after stop, such as a timer or a promise callback.

Most such code needs no check. These members are safe to use between runs:

| Use | Between runs |
| --- | --- |
| [`mist.settings`](#mistsettings) | Reads the schema's defaults. Writes do nothing. |
| [`mist.data`](#mistdata) | Reads the initial value. Writes do nothing. |
| [`mist.toast`](#misttoast) | Does nothing. |
| [`mist.flux`](#mistflux) | `on` does nothing, and `next` rejects. |
| [`mist.signal`](#mistsignal) | Is already aborted. |

The first write or subscription of each kind that does nothing logs one debug line per copy of the plugin, as in `mist.settings.set: ignored while weather-demo is stopped`. A stray timer shows up in `mist logs` without filling it.

```ts
// No mist.running check: after stop, this does nothing
function onTimer() {
	mist.settings.set("lastSeen", Date.now());
}
```

Check `mist.running` for what only the context has, such as `mist.ctx.command`.

### mist.signal

```ts
readonly signal: AbortSignal;
```

An `AbortSignal` that aborts when the current run is disposed, at the same moment `mist.running` becomes `false`. Each `start` makes a new one, and a `start` that comes without a dispose of the run before aborts that run's signal. Read between runs, it is already aborted. Its `reason` is a `DOMException` named `AbortError`, with the message `<id> stopped`.

Read it in `start`, or in code the run starts, and pass it to anything that takes a signal: `sleep` and `fetchWithTimeout` from [`@aurologic/mist-api/util`](util.md), `fetch`, and `addEventListener`.

```ts
async start() {
	const signal = mist.signal;
	while (!signal.aborted) {
		const answer = await fetchJson("https://api.example.com/status", { signal }).catch(() => null);
		if (answer) render(answer);
		await sleep(60_000, signal).catch(() => { });
	}
},
```

Keep the run's signal in a variable, as above. After a restart, `mist.signal` is the new run's signal, and a loop from the old run that reads it each time would keep going.

### mist.toast

```ts
toast(message: ReactNode, options?: ToastOptions): void;
```

`ctx.toast` while the plugin runs. Between runs it does nothing, where `mist.ctx.toast` throws. Use it in a promise callback or a timer that can finish after the plugin stops.

```ts
mist.native.export(path).then(() => mist.toast("Exported", { type: "success" }));
```

### mist.settings

```ts
readonly settings: MistSettings<S>;

interface MistSettings<S> extends ChangeSource {
	get<K extends keyof S & string>(key: K): SettingsValues<S>[K];
	set<K extends keyof S & string>(key: K, value: SettingsValues<S>[K]): void;
	all(): SettingsValues<S>;
	onChange(listener: (values: SettingsValues<S>) => void): () => void;
	use<K extends keyof S & string>(key: K): SettingsValues<S>[K];
}
```

The plugin's settings, from the schema passed to `define`, readable at any time. While the plugin runs, `get` and `set` are `ctx.settings.get` and `set`. Between runs, `get` gives the schema's default and `set` does nothing, where `mist.ctx.settings` throws.

- `all()` is a copy of every value.
- `onChange(listener)` calls `listener` with a copy of every value each time one changes, until you call the function it returns. It isn't called when you subscribe. It lasts across runs: a start or a stop that changes what the settings read, from stored values to defaults or back, calls it too. Subscribe once at module level, or pass the returned function to `ctx.onDispose`.
- `use(key)` is a React hook that returns the key's value and renders the component again only when that value changes.
- `mist.settings` is a [`ChangeSource`](stores.md#changesource-and-fluxstore): `useStore` and `subscribe` take it like a Flux store. Its change listeners run on every change and on each start and stop.

A listener that throws doesn't stop the others. Each distinct failure is logged once through `mist.log.error`.

```tsx
mist.settings.onChange(values => mist.log.info("units are now", values.units));

function Units() {
	const units = mist.settings.use("units");
	return <span>{units === "imperial" ? "°F" : "°C"}</span>;
}

function Place() {
	const label = useStore(mist.settings, () => `${mist.settings.get("latitude")}, ${mist.settings.get("longitude")}`);
	return <span>{label}</span>;
}
```

### mist.data

```ts
data<T>(key: string, initial: T, options?: DataOptions<T>): MistData<T>;

interface MistData<T> extends ChangeSource {
	get(): T;
	set(value: T): void;
	update(fn: (current: T) => T): void;
	use(): T;
	onChange(listener: (value: T) => void): () => void;
}

interface DataOptions<T> {
	parse?(raw: unknown): T;
}
```

A typed value kept with the plugin's settings but outside its schema, for state that isn't a setting: a dismissed notice, the time of the last check, a chosen tab. Evi stores it with the plugin's settings under `__mist_data:<key>`, and its settings UI doesn't show it. For larger data, or data per account, use [`mist.storage`](#miststorage).

- `get()` returns a fresh JSON copy of the stored value, or of `initial` when there is none (without `parse`): changing the returned object changes neither what is stored nor the next read.
- `set(value)` stores a JSON copy of `value`: changing the object afterwards changes nothing stored. A value that JSON can't hold, such as a `BigInt`, a cycle, a function, or `undefined`, throws a `TypeError` that names the key, and nothing is stored. Setting a value whose JSON equals the stored one does nothing and tells no listener.
- `update(fn)` calls `fn` with the current value from `get()` and passes its result to `set`.
- Between runs, `get` gives a copy of `initial` (or `initial` as given with `parse`), and `set` and `update` do nothing.
- `onChange(listener)` calls `listener` with a fresh copy of the value each time it changes, until you call the function it returns. It hears writes through any `mist.data` object of the plugin, and each start and stop. It doesn't hear a write made straight to `ctx.settings`.
- `use()` is a React hook that returns the cached snapshot and renders the component again when it changes. Don't mutate what `use()` returns in place; copy it or read with `get()` first.
- A `MistData` is a [`ChangeSource`](stores.md#changesource-and-fluxstore) with a `get`. `useStore`, `subscribe`, and `useValue` from [`@aurologic/mist-api/ui`](ui.md#state) take it like a `State`.

The stored value is JSON that an older version of the plugin may have written in another shape. Without `parse`, `get` returns a fresh JSON copy unchecked as `T`. With `parse`, `get` runs `parse` once on a fresh copy of each stored value and keeps its result across reads; `initial` is also returned as given, without copying, so non-JSON types such as a `Map` or class instance stay intact (don't mutate either in place). When `parse` throws, `get` returns `initial` and logs the error once.

```ts
const lastCheck = mist.data("lastCheck", 0, { parse: raw => typeof raw === "number" ? raw : 0 });

async function check() {
	if (Date.now() - lastCheck.get() < 3_600_000) return;
	lastCheck.set(Date.now());
	await refresh();
}
```

Call `data` once for each key, at module level, and share the object. [Settings migrations](#settings-migrations) shows how to move an older undeclared key into `mist.data`.

### mist.flux

```ts
readonly flux: MistFlux;

interface MistFlux {
	on<A extends FluxAction = FluxAction>(types: string | readonly string[], handler: (action: A) => void): () => void;
	next<A extends FluxAction = FluxAction>(types: string | readonly string[], options?: NextOptions<A>): Promise<A>;
}

interface NextOptions<A> {
	where?: (action: A) => boolean;
	timeout?: number;
	signal?: AbortSignal;
}
```

Flux actions through the running context's `ctx.flux.subscribe`. Evi guards and times each handler and removes it when the run stops. Pass an action type as `A` to type the handler's argument.

- `on(types, handler)` calls `handler` with each action of the given types until the run stops or you call the function it returns. Between runs it subscribes nothing and returns a function that does nothing.
- `next(types, options)` resolves with the next action of the given types that `where` accepts, and then removes its handler. It rejects with `mist.signal`'s reason when the run stops, at once between runs, with `signal`'s reason when it aborts, with a `TimeoutError` `DOMException` after `timeout` ms, and with any error `where` throws. `timeout` follows the rules of [`withTimeout`](util.md#withtimeout).

```ts
interface MessageCreate extends FluxAction { channelId: string; message: { content: string; }; }

async start() {
	mist.flux.on(["CHANNEL_SELECT", "GUILD_CREATE"], redraw);
	const created = await mist.flux.next<MessageCreate>("MESSAGE_CREATE", { where: a => a.channelId === channelId, timeout: 30_000 }).catch(() => null);
}
```

### mist.storage

```ts
readonly storage: PluginStorage;

interface KeyValueStore {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	update(key: string, fn: (value: unknown) => unknown): Promise<unknown>;
	del(key: string): Promise<void>;
	keys(): Promise<string[]>;
	clear(): Promise<void>;
}

interface PluginStorage extends KeyValueStore {
	account(userId: string): KeyValueStore;
}
```

A key-value store for the plugin, kept in the page's IndexedDB between runs and restarts. Use it for data too large for `ctx.settings`, such as a cache or a history. It works whether or not the plugin runs.

- Each plugin id gets a database named `mist-api:<id>`. It never opens the `evi-<id>` database that Evi's plugin guide suggests, and a plugin that already keeps one doesn't clash with it.
- Values are stored as JSON text, with `JSON.stringify`'s rules: a `Date` comes back as its ISO string, and a key whose value is `undefined` is dropped. `set` of a value JSON can't write, such as a `BigInt` or a cycle, rejects with `JSON.stringify`'s error and stores nothing. Each `get` returns a new copy.
- `get` returns `unknown` because the stored data is outside the type system: an older version of the plugin may have written it. Check it before use, as with `fetchJson`.
- `update` reads the value, calls `fn` with it, and writes what `fn` returns, in one transaction. Two updates of a key at the same time run one after the other, and neither loses the other's write. `fn` must be synchronous, because IndexedDB ends the transaction at the first `await`. An `fn` that returns a promise makes `update` reject with a `TypeError`, and nothing is stored. If `fn` returns `undefined`, the key is deleted. If `fn` throws, nothing changes and `update` rejects with that error. `update` resolves to the stored value.
- Every error rejects the call's promise. Where IndexedDB is missing, or throws when it is opened, each call rejects with `IndexedDB isn't available on this page, so mist-api:<id> can't be opened` or IndexedDB's error. The next call tries again.
- If another page deletes or upgrades the database, mist closes its connection to avoid blocking it, and opens the database again on the next call.

```ts
const seen = await mist.storage.update("seen", value => (typeof value === "number" ? value : 0) + 1);
await mist.storage.set("cache", { at: Date.now(), items });
```

`account(userId)` is a separate store for one Discord account, in the database `mist-api:<id>:account:<userId>`. Discord switches accounts without reloading the page. Data that belongs to an account, such as drafts or per-server state, goes in that account's store. Bind the store when you start work for an account, and bind again after a switch: a write that finishes after a switch then still goes to the account it belongs to. `account` throws a `TypeError` for an empty or missing id.

```ts
import { currentUserId } from "@aurologic/mist-api/stores";

const userId = currentUserId();
if (userId) await mist.storage.account(userId).set("draft", text);
```

### mist.native

```ts
readonly native: NativeClient<N>;
```

Calls the plugin's native methods through `ctx.native.call`. Each method takes the native method's arguments and returns a promise of its result. Electron's IPC structured-clones arguments and results on the way: pass plain data.

```ts
const forecast: { temperature: number; } | null = await mist.native.forecast({ latitude: 48.86, longitude: 2.35 });
const sum: number = await mist.native.add(1, 2);
```

`NativeClient<N>` lists every method of `N` except `start`, `stop`, and the hidden `__mist_` methods that `defineNative` adds.

The page side records every call, with its arguments, outcome, and time taken, for `mist calls`. A call before `start` or after stop fails with the `mist.ctx` error, and the failure is recorded too.

`mist.native` is a `Proxy`. Its `then` is `undefined`, so `await mist.native` returns `mist.native` itself instead of treating it as a promise. Every other property name gives a calling function at runtime. A method the native side doesn't have fails only when the call reaches Evi; the type `N` is what catches a wrong name.

Errors keep their type when the native side is made with `defineNative` from mist-api 0.3 or later. A `NativeError` thrown there rejects the call with a `MistNativeError` with the same `code` and `data`, and an `HttpError` keeps its `status`. [NativeError](native.md#nativeerror) shows both sides. With an older or plain native side, a throw arrives as Electron makes it: a plain `Error` whose message starts with `Error invoking remote method`.

```ts
import { MistNativeError } from "@aurologic/mist-api";

try {
	await mist.native.readNote(name);
} catch (err) {
	if (err instanceof MistNativeError && err.code === "not-found") return null;
	throw err;
}
```

`mist.native.method.with({ signal })` returns the method with a signal. Aborting the signal rejects the call at once with the signal's reason. With a native side made with `defineNative` from mist-api 0.3 or later, it also aborts the method's `this.signal`, and the native work can stop. With another native side, the native method runs on and its answer is dropped. A signal that is already aborted rejects without calling the native side.

```ts
const controller = new AbortController();
const pending = mist.native.download.with({ signal: controller.signal })(url);
cancelButton.onclick = () => controller.abort();
```

The first call of each run asks the native side whether it speaks mist-api's call protocol: one extra call that isn't recorded. [How a call crosses IPC](native.md#how-a-call-crosses-ipc) explains it.

### mist.requests

```ts
readonly requests: MistRequests<RequestsOf<N>>;

interface MistRequests<R> {
	handle<K extends keyof R>(name: K, handler: (payload: Parameters<R[K]>[0]) => Awaited<ReturnType<R[K]>> | Promise<Awaited<ReturnType<R[K]>>>): () => void;
}
```

Answers the requests that the native side makes with [nativeRequests](native.md#nativerequests). `RequestsOf<N>` is the native module's request map: the names and types come from `native.ts`. What `handler` returns or resolves with goes back to the waiting native code. A throw or rejection goes back as a failure with its message. Call `handle` while the plugin runs, as in `start`. Its handlers belong to the run and end with it. A second `handle` for a name replaces the first, and the returned function removes the handler.

```ts
mist.requests.handle("confirm", text => window.confirm(text));
```

The answer must survive a structured clone. One that doesn't is logged, and the native side gets a failure. The page starts polling for requests at the first `handle` of a run. A native side without requests support, older than mist-api 0.3 or not made with `defineNative`, gets no polls, and the page logs that once. When asking the native side fails for a reason unrelated to requests, such as a native side in the middle of a restart, the page asks again after a growing delay, from 1 second, until it gets an answer or the run ends.

### mist.log

```ts
interface MistLog {
	log(...args: unknown[]): void;
	debug(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
}
```

Records each line for `mist logs` and, while the plugin runs, prints it through the `ctx.logger` method of the same name. `log` is Vencord's `Logger.log`, for compat layers that port Vencord plugins. A line written while the plugin isn't running is only recorded, never printed.

Arguments are recorded like call arguments. The page-wide handle shows every argument as its type and size, strings included. The CLI's view shows them whole, with fields named like secrets masked. `ctx.logger` also prints them to the page's console, where any plugin that wraps `console` can read them: don't put a secret in a log string.

### mist.events

```ts
readonly events: MistEvents<EventsOf<N>>;

interface MistEvents<E> {
	subscribe(listener: (event: E) => void, options?: SubscribeOptions): () => void;
}
```

Reads the native side's event channel, made with `nativeEvents` and passed to `defineNative`. `EventsOf<N>` is the channel's event type, taken from the native module. `subscribe` calls `listener` with each event in order, and runs `options.onConnect` whenever the page has to load its state. The subscription ends when the run is disposed. [Events](events.md) covers it in full.

```ts
mist.events.subscribe(event => apply(event), { onConnect: refresh });
```

### mist.expose

```ts
expose(name: string, getter: () => unknown): void;
```

Publishes a value for `mist values`. The getter runs only when the CLI asks. If it throws, the value shows as `{ "error": "<message>" }`. A second `expose` with the same name replaces the getter.

```ts
mist.expose("forecast", () => forecast);
```

### mist.safe

```ts
safe<A extends unknown[], R>(fn: (...args: A) => R, fallback: (...args: A) => R, options?: SafeOptions): (...args: A) => R | undefined;
safe<A extends unknown[], R>(fn: (...args: A) => R, fallback: R, options?: SafeOptions): (...args: A) => R;

interface SafeOptions {
	message?: string;
}
```

Returns a version of `fn` that never throws. If `fn` throws, the wrapper returns the fallback and logs the error through `mist.log.error`, as in `lineText threw; returning its fallback`. It is for `$self` callbacks in source patches, which run inside Discord's code, where a throw breaks Discord's rendering.

The fallback is a value or a function:

- A value is returned as it is.
- A function is called with the same `this` and arguments as `fn`, and its result is returned. Use it to fall back to Discord's value, as in `line => line.text`. If the function throws too, the wrapper logs `<name>'s fallback threw; returning undefined` and returns `undefined`. The result type includes `undefined` for that reason.
- A function is always called. If `fn` itself returns a function, such as a component, wrap the fallback in another function: `() => Original`.

`options.message` replaces the default error line. Use it to keep a line that the plugin logged before it used `mist.safe`, as in `{ message: "Couldn't draw the forecast row" }`. The error itself is still logged after it.

- The wrapper passes its `this` to `fn`.
- Each distinct error message is logged once. After 50 distinct messages, new ones aren't logged at all, though the fallback is still returned.
- `fn.name` names the callback in the log line. An anonymous function shows as `A patch callback`.
- Only a synchronous throw is caught. A rejected promise from an `async` function passes through.

```ts
export default mist.define({
	patches: [{
		find: "renderForecastRow",
		replace: { match: /(\i)\.text/, with: "($self?.lineText?.($1)??$1.text)" },
	}],
	lineText: mist.safe(function lineText(line: { text?: string; }) {
		return line.text!.trim();
	}, ""),
	// Falls back to Discord's text, and logs a custom line
	lineTitle: mist.safe(function lineTitle(line: { title?: string; }) {
		return line.title!.toUpperCase();
	}, line => line.title, { message: "Couldn't format the line title" }),
});
```

## Plugins that depend on each other

Two plugins that talk over the [bus](bus.md) break silently when the user updates only one of them and the protocol version changed. `provides` and `needs` let mist-api find this and tell the user which plugin to update.

```ts
interface Need {
	readonly plugin: string;
	readonly protocol: string;
	readonly version: number;
}
```

The plugin that offers a protocol lists it in `provides`, with the version it speaks. Use the same name and version as its bus channel or slot. The plugin that uses it lists it in `needs`, with the other plugin's id.

```ts
// In the plugin that publishes forecasts
export const mist = createMist("weather-demo", { provides: { "weather-feed": 2 } });

// In a plugin that shows them
export const mist = createMist("forecast-panel", {
	needs: [{ plugin: "weather-demo", protocol: "weather-feed", version: 2 }],
});
```

`provides` goes on the plugin's handle in the page registry, as `MistHandle.provides`, and in `HandleState.provides`.

After each `start` of a plugin with `needs`, the wrapper looks up each needed plugin with `Evi.plugins.get` and reads its version of the protocol from its handle. It checks again whenever Evi's plugin list changes, which includes an install, an update, and turning a plugin on, until the run ends. If it can't follow Evi's plugin list, it logs a warning and checks only at start. A need is met when the versions are equal. Otherwise:

- If the other plugin provides an older version, or its handle doesn't say it provides the protocol, the warning says to update the other plugin. A plugin built with mist-api 0.2.1 or earlier, or without mist-api, never says what it provides.
- If the other plugin provides a newer version, the warning says to update this plugin.

The warning is printed through `mist.log.warn` and listed in `HandleState.warnings` while it applies. The user also gets a toast that names the plugin to update, as in `forecast-panel needs a newer version of Weather. Update Weather to use them together.` The log line and the toast happen once per need for each copy of the plugin, which means once per Discord session unless the plugin is reloaded.

A needed plugin that isn't installed isn't checked: a plugin may work without it. One that is turned off isn't checked either. Evi doesn't run its code until it is turned on, and until then it hasn't said what it provides.

## onDemand

```ts
function onDemand<P extends object>(patch: P): P;
```

Marks a source patch whose module is in code Discord downloads only when a screen first opens, such as a settings screen or a video player. Until that code is downloaded, Evi finds no module for the patch and calls it broken. `mist status` and `mist patches` show a marked patch as waiting instead. A patch without the mark still shows as broken, and a patch whose code Discord removed is still reported. Once the module loads, Evi checks the patch as usual: a match that no longer fits shows as failed or partial whether it's marked or not.

```ts
import { onDemand } from "@aurologic/mist-api";

patches: [
	// Only in the media viewer, which Discord downloads when it first opens
	onDemand({
		find: "mediaViewerControls",
		replace: { match: /.../, with: "..." },
	}),
],
```

It sets a `$mistOnDemand` property on the patch object and returns the same object. Evi keeps the object it was given, and the mark reaches its diagnosis. Evi's Patches tab doesn't read the mark and still shows such a patch as broken until its code is downloaded.

## The page registry

The first copy of mist-api to run `createMist` installs the page's debug registry under `Symbol.for("mist-api.registry.v1")`. Later copies join it. It also defines `window.Mist`, which every plugin and the CLI can read:

| Member | Returns |
| --- | --- |
| `Mist.version` | `1` |
| `Mist.list()` | `{ id, mistVersion, running }` for each registered plugin |
| `Mist.get(id)` | The plugin's `MistHandle`, or `undefined` |
| `Mist.status()` | Each plugin's `HandleState`, its start error from Evi, its registry history and concerns, and its patch and lookup health from `Evi.diagnosePatches` and `Evi.diagnoseLookups` |

The registry under the `Symbol.for` key also has `register(handle)`, `history(id)`, and `concerns(id)`. `history` counts how the id's handle changed hands: `registered`, `replaced`, `refused`, and `reclaimed`. `concerns` lists why the CLI shouldn't trust the handle, and is empty when nothing is wrong. [Security model](security.md#replacing-a-handle) explains both.

A `MistHandle` shows each value only as its type and size, as in `"object(2 keys)"` or `"string(12)"`, including log text and the message of a failed call. Its `call` always rejects. The whole view and calls live on the plugin's debug capability, which the handle holds in a private field that only a CDP client can read. [Security model](security.md#two-views-of-each-plugin) explains the two views.

```ts
interface MistHandle {
	readonly id: string;
	readonly mistVersion: string;
	readonly provides?: Readonly<Record<string, number>>;
	state(): HandleState;
	logs(n?: number): LogRecord<Reduced>[];
	calls(n?: number): CallRecord<Reduced>[];
	nativeLogs(n?: number): Promise<ReducedNativeLogs | null>;
	values(): Record<string, Reduced>;
	settings(): Record<string, Reduced> | null;
	call(method: string, ...args: unknown[]): Promise<never>;
	owns?(value: unknown): boolean;
}

interface HandleState {
	id: string;
	mistVersion: string;
	running: boolean;
	startedAt: number | null;
	native: "unknown" | "none" | "plain" | "mist";
	debug: boolean;
	errors: { calls: number; logs: number; };
	quiet?: Record<string, number>;
	provides?: Record<string, number>;
	warnings?: string[];
}
```

`provides` is the plugin's `provides` option. `warnings` lists what the plugin got wrong in the current run: a [store read too early](#stores-read-too-early), a [needed plugin at another version](#plugins-that-depend-on-each-other), a [settings migration](#settings-migrations) that threw, or a [`$self` name](#self-names) that the definition lacks. Handles made by copies of 0.2.1 and earlier have neither field. Warnings aren't registry concerns and don't make `mist call` refuse.

`owns(value)` is `true` only for the `Mist` object that `createMist` made with this handle. [Permissions through mist](security.md#permissions-through-mist) explains how `discord()` and the UI registries use it.

`HandleState.native` is `"unknown"` until the plugin first starts. Then it is `"none"` for a plugin without a native module, `"plain"` for a native module not made with `defineNative`, and `"mist"` for one made with `defineNative`. `errors` counts the failed calls and the `error` lines still kept in the page side's rings. `quiet` counts the calls of each `quiet` method.

## Recorded values

Every recorded argument, result, exposed value, and setting is copied once, when it is recorded, into a JSON-safe `Snapshot`. Later changes to the object don't change the record. A snapshot has these limits:

- A string keeps its first 2000 characters, followed by a note of how many were cut.
- An array, a `Set`, or a `Map` keeps its first 50 items. A `Map` becomes an array of `[key, value]` pairs, and a value whose key is a secret name is masked.
- An object keeps its first 50 keys.
- Nesting stops at depth 6 with `"[too deep]"`, and a cycle shows as `"[circular]"`.
- `undefined` becomes `null`, a function becomes `"[function name]"`, a `bigint` becomes `"12n"`, a `Date` becomes its ISO string, and an `Error` becomes `{ error, message }`.

## Exported types

`@aurologic/mist-api` also exports these types:

- Plugin: `Mist`, `MistOptions`, `MistLog`, `SafeOptions`, `MistDefinition`, `DefinedPlugin`, `Migration`, `MigrationSettings`.
- State: `MistSettings`, `MistData`, `DataOptions`, `MistFlux`, `NextOptions`, `KeyValueStore`, `PluginStorage`.
- Plugins together: `Need`, `Provides`.
- Native side: `MistEvents`, `SubscribeOptions`, `EventsOf`, `EventsAnswer`, `NativeClient`, `NativeFunction`, `CallOptions`, `MistRequests`, `RequestsOf`.
- Debugging: `MistCapability`, `MistHandle`, `HandleState`, `NativeKind`, `RegistryHistory`, `CallRecord`, `CallOutcome`, `LogRecord`, `LogLevel`, `NativeLogs`, `ReducedNativeLogs`, `Shown`, `Reduced`, `Snapshot`.

`Reduced` is a branded string, the type and size that a reduced view shows. `Shown` is `Snapshot | Reduced`, a value from a view that may or may not be open. `MIST_VERSION` is the version string of the copy, as in `"0.5.0"`. `SETTINGS_VERSION` is the settings key that holds the migrated version, `"__mist_settingsVersion"`.
