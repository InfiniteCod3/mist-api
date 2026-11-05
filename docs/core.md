# createMist

`@aurologic/mist-api` is the page side of a plugin. It exports `createMist`, `onDemand`, the `MIST_VERSION` and `SETTINGS_VERSION` constants, and the types listed at the end of this page. `mist.events` is the page side of the [event channel](events.md).

```ts
import { createMist } from "@aurologic/mist-api";
```

## createMist

```ts
function createMist<S extends SettingsSchema = {}, N = {}>(id: string, options?: MistOptions<N>): Mist<S, N>;
```

Returns the plugin's `Mist` object. Call it once per plugin, at module level, and export the result so the plugin's other files can import it.

- `S` is the plugin's settings schema, the same type that `definePlugin` takes. Pass `typeof settings`. Without it, `mist.ctx.settings.get` accepts no keys.
- `N` is the type of the native module. Pass `typeof native`, where `native` is the default export of `native.ts` imported with `import type`. Without it, `mist.native` has no methods.
- `id` is the plugin's id from `manifest.json`. Errors and the debug registry name the plugin by it.

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
| `quiet` | `[]` | Native methods whose calls are counted and not kept, such as a long poll that would push every other call out of the ring. A call of one that fails is kept like any other. `HandleState.quiet` and `mist status` show the counts. Only `N`'s methods can be named. |
| `capacity` | `200` | How many native calls the page side keeps, and how many log lines. Each has its own ring of this size. It must be a positive integer. |
| `provides` | `{}` | The bus protocols this plugin provides to other plugins, each with the version it speaks, as in `{ "weather-feed": 2 }`. Each version must be an integer of 1 or more, or `createMist` throws. [Plugins that depend on each other](#plugins-that-depend-on-each-other) explains it. |
| `needs` | `[]` | The protocols this plugin speaks with other plugins: `{ plugin, protocol, version }` for each, where `plugin` is the other plugin's id. [Plugins that depend on each other](#plugins-that-depend-on-each-other) explains it. |

The built-in names are every field or `Map` key whose name matches `token`, `secret`, `passw`, `cookie`, `authorization` or `authorisation`, `api_key` (or `apikey`, `api-key`), `credential`, or `session` anywhere in the name. A masked field shows as `"[secret]"`. An empty or missing value isn't masked.

A token count isn't a token. A field whose name ends in `tokens` and whose value is a number is shown, as in `input_tokens`, `output_tokens`, or `maxTokens`. A string, an object, or an array under such a name is still masked, and so is a number under `token` or `accessToken`.

Masking goes by name: an object field's name, or a `Map` entry's string key. A bare string can't be recognized as a secret, because nothing names it. A secret passed as a positional argument, as in `mist.native.login(key)`, or as an item of an array, shows whole in the open view. Pass it inside an object instead, as in `mist.native.login({ apiKey: key })`. When the signature can't change, name its position in `secretArgs`. A `login(user, code)` method that takes a one-time code second passes `{ secretArgs: { login: [1] } }`. A masked argument shows as `"[secret]"` whole and as `string(8)` reduced, so not even its length is kept.

The page side and the native side record separately, so give the same `secrets`, `reveal`, `secretArgs`, and `quiet` to `createMist` and to `defineNative`.

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
	readonly log: MistLog;
	readonly events: MistEvents<EventsOf<N>>;
	readonly signal: AbortSignal;
	toast(message: ReactNode, options?: ToastOptions): void;
	readonly storage: PluginStorage;
	define(definition: MistDefinition<S>): PluginDefinition<S>;
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
define(definition: MistDefinition<S>): PluginDefinition<S>;

type MistDefinition<S> = PluginDefinition<S> & { migrate?: readonly Migration<S>[] };
```

Wraps the plugin's definition. Use it in place of `definePlugin` and export its result as the default export.

The returned definition is a copy of `definition` without `migrate` and with a wrapped `start`. The wrapper does these things before it calls your `start` with the same `this` and context:

1. It sets the context that `mist.ctx` returns.
2. It registers a dispose callback on the context that aborts the run's `mist.signal` and clears `mist.ctx`. The callback only clears `mist.ctx` if the context is still the current one, so a late dispose from an earlier run doesn't clear a newer run.
3. It asks the native side whether Discord's main process has a debugging port. The first answer is kept. A rejected call is asked again on the next debug request. [Security model](security.md) explains this check.
4. It aborts the previous run's [`mist.signal`](#mistsignal), if that run wasn't disposed, and makes a new one for this run.
5. It clears the previous run's warnings, lists the [`$self` names](#self-names) that the definition lacks, and runs the [settings migrations](#settings-migrations) that the stored settings don't have yet.

While your `start` runs, and until it returns or reaches its first `await`, the wrapper watches the `stores` getters of [`@aurologic/mist-api/stores`](stores.md). After `start` returns, it checks the plugins in `needs`, as [Plugins that depend on each other](#plugins-that-depend-on-each-other) describes.

#### Stores read too early

Evi starts plugins as soon as Discord's React and Flux dispatcher exist, which is often before Discord has made stores such as `PresenceStore`. A `stores` getter read in `start` then gives `undefined`, and code such as `subscribe([stores.presence], redraw)` listens to nothing, with no error.

Each store that a getter reads as missing during `start` is a warning for the plugin. The warning names the store and the fix: name the store, as in `subscribe(["PresenceStore"], redraw)` or `useStore("PresenceStore", getter)`, which wait for it. `mist.log.warn` prints it once per copy of the plugin, and `HandleState.warnings` lists it for each run in which it happens.

Only the synchronous part of `start` is watched. Evi calls the starts one after another, and calls the next one when the previous one returns or reaches its first `await`. Until then, only that plugin's code runs, so a missing store can be attributed to it. After an `await`, other plugins' code and Discord's code run too, so a missing store can't be attributed to anyone, and it isn't reported. `findStore` from `@evi/api` is Evi's own function and isn't watched either. A store named to `subscribe` or `useStore` is never a warning, because those wait for it.

`define` also registers the plugin in the page's debug registry. A second `define` call on the same `Mist` object replaces its own registration. A new copy of the plugin, as after a hot reload, replaces the old copy's handle once the old run has stopped. Each `start` checks that the plugin's handle still holds its id and registers it again if another handle took it while the plugin was stopped. [Security model](security.md#replacing-a-handle) explains the rules.

```tsx
export default mist.define({
	settings,
	async start(ctx) {
		const forecast = await mist.native.lookup({ latitude: ctx.settings.get("latitude"), longitude: ctx.settings.get("longitude") });
		mist.log.info(forecast ? `${forecast.temperature} °C` : "no forecast");
	},
});
```

Evi runs `stop` before the context's dispose callbacks, so `mist.ctx` and `mist.running` still work inside `stop`.

#### $self names

Evi rewrites `$self` in a source patch's replacement into a reference to the plugin's definition. A misspelt name, as in `$self?.injectButon?.(e)`, gives `undefined` inside Discord's code: the patch does nothing, or a call without `?.` throws a `TypeError` in Discord's own render, far from the patch.

`define` reads every string `with` in `patches` for `$self.name` and `$self?.name`, and checks each name against the definition it returns. A name the definition doesn't have, or a name that is called, as in `$self.name(` or `$self?.name?.(`, without a function by that name, is a warning. `mist.log.warn` prints it once per copy of the plugin, and `HandleState.warnings` lists it for every run, so `mist status --json` and the debug report show it. When exactly one function name of the definition is within two letters of the missing name, the warning suggests it:

```text
patches[1] calls $self.injectButon, but the definition has no function injectButon, so Discord's code gets undefined there. Did you mean injectButton?
```

A `with` that is a function isn't checked, because its text exists only when Evi calls it on a module's code. Nor is a name written another way, such as `$self["name"]`.

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

When a new version of a plugin renames a setting or changes its shape, a migration moves the stored value. Evi keeps the stored values of keys that the schema no longer declares: it saves and loads the plugin's whole settings entry as it is, and `ctx.settings.get` reads any stored key. So a migration can read the value under the old name and write it under the new one.

Each migration has a `to`, the settings version it makes. Versions are integers from 1. The wrapper stores the version that the plugin's settings have reached under the key `__mist_settingsVersion` in the plugin's own settings (exported as `SETTINGS_VERSION`). Settings without that key are at version 0.

Before each `start`, the wrapper runs every migration whose `to` is higher than the stored version, in order of `to`, and stores each `to` after its migration returns. A migration's writes and the new version go into Evi's settings in the same synchronous step, so Evi saves them together. This is why `run` must be synchronous.

- `get` reads the stored value under any key. For a key that the schema declares and that was never set, it gives the default. For any other key that was never set, it gives `undefined`.
- `set` writes a key that the schema declares, with its type.
- A migration also runs for a user who installed the plugin after the change, whose settings have no old values. Write each one so that it does nothing then: check that the old value exists and has the shape you expect.
- If a migration throws, the wrapper logs `Settings migration to <to> threw`, with the error, through `mist.log.error`, and adds the same line to `HandleState.warnings`. The migrations after it don't run, and the plugin starts with its settings as they are. At the next start, the failed migration runs again. Writes it made before it threw stay, so write a migration that can run twice.
- `define` throws if a `to` isn't an integer of 1 or more, or if two migrations have the same `to`.

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

The old values stay in the stored settings after a migration. Evi doesn't show them, because its settings UI lists only declared keys.

### mist.report

```ts
report(): Promise<string>;
```

A debug report that the plugin's user can paste into a bug report. The CLI needs a debugging port, which most users can't set up. The report has:

- The plugin's id and version, the mist-api version, the Evi version, and Discord's release channel and build when the page shows them.
- The plugin's status, as `Mist.status()` gives it: running or stopped, the kind of native side, error counts, Evi's start error, `HandleState.warnings`, registry concerns, and patch and lookup problems.
- The last 50 page log lines and native calls, and, for a native side made with `defineNative`, the last 50 log lines and calls on the native side.

It is built from the plugin's page-wide handle only, so every argument, result, log argument, and error message shows as its type and size, as in `string(28)`. No value that a plugin recorded appears in it. The text of Evi's start error, of patch errors from Evi, and of mist's own warnings appears whole.

### mist.copyReport

```ts
copyReport(): Promise<boolean>;
```

Copies the report to the clipboard and resolves to whether that worked. It uses `navigator.clipboard.writeText`. If that is refused, as when the page doesn't have focus, it copies from a hidden, selected `textarea` with `document.execCommand("copy")`. While the plugin runs, it shows a toast that says whether it copied.

Evi's settings schema has no button type. To offer the report in the plugin's settings, put a button in `settingsPanel`:

```tsx
import { Components } from "@evi/api";

export default mist.define({
	settings,
	settingsPanel: () => Components.Button
		? <Components.Button onClick={() => void mist.copyReport()}>Copy debug report</Components.Button>
		: null,
});
```

`Components.Button` is Discord's own button, and it is `undefined` when Discord renamed it, so check it before you render it.

### mist.reportCommand

```ts
reportCommand(name?: string): CommandDefinition;
```

A slash command for `ctx.command` that copies the report and replies with a message only the user sees. If copying fails, the reply contains the report in a code block. The default name is the plugin id followed by `-report`, lowercased, with characters other than letters, digits, `-`, and `_` replaced by `-`, cut to 32 characters.

```ts
start(ctx) {
	ctx.command(mist.reportCommand());
},
```

Typing a slash command lets the user get a report even when the plugin's settings don't open.

### mist.ctx

```ts
readonly ctx: PluginContext<S>;
```

The plugin's context while it runs. Reading it between runs throws an `Error` whose message names the plugin, as in `weather-demo isn't running: mist.ctx only exists from start until the run is disposed`.

### mist.running

```ts
readonly running: boolean;
```

`true` between `start` and the context's dispose. Check it before `mist.ctx` in code that can run after stop, such as a timer or a promise callback.

```ts
function onTimer() {
	if (!mist.running) return;
	mist.ctx.settings.set("lastSeen", Date.now());
}
```

For a toast or for work to cancel, [`mist.toast`](#misttoast) and [`mist.signal`](#mistsignal) need no check.

### mist.signal

```ts
readonly signal: AbortSignal;
```

An `AbortSignal` that aborts when the current run is disposed, at the same moment `mist.running` becomes `false`. Each `start` makes a new one, and a `start` without a dispose of the run before aborts that run's signal. Read between runs, it gives a signal that is already aborted. Its `reason` is a `DOMException` named `AbortError`, with the message `<id> stopped`.

Read it in `start`, or in code that the run starts, and pass it to anything that takes a signal: `sleep` and `fetchWithTimeout` from [`@aurologic/mist-api/util`](util.md), `fetch`, and `addEventListener`.

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

Keep the signal of the run in a variable, as above. `mist.signal` read again after a restart is the new run's signal, so a loop from the old run that reads it each time would keep going.

### mist.toast

```ts
toast(message: ReactNode, options?: ToastOptions): void;
```

`ctx.toast` while the plugin runs. Between runs it does nothing, where `mist.ctx.toast` throws. For a promise callback or a timer that can finish after the plugin stops.

```ts
mist.native.export(path).then(() => mist.toast("Exported", { type: "success" }));
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

- Each plugin id has its own database, named `mist-api:<id>`. It never opens the `evi-<id>` database that Evi's plugin guide suggests, so a plugin that already keeps one doesn't clash with it.
- Values are stored as JSON text, so `JSON.stringify`'s rules apply: a `Date` comes back as its ISO string, and a key whose value is `undefined` is dropped. `set` of a value that JSON can't write, such as a `BigInt` or a cycle, rejects with `JSON.stringify`'s error and stores nothing. Each `get` returns a new copy.
- `get` returns `unknown` because the stored data is outside the type system: an older version of the plugin may have written it. Check it before use, as with `fetchJson`.
- `update` reads the value, calls `fn` with it, and writes what `fn` returns, in one transaction. Two updates of a key at the same time run one after the other, so neither loses the other's write. `fn` must be synchronous, because IndexedDB ends the transaction at the first `await`. An `fn` that returns a promise makes `update` reject with a `TypeError`, and nothing is stored. If `fn` returns `undefined`, the key is deleted. If `fn` throws, nothing changes and `update` rejects with that error. `update` resolves to the stored value.
- Every error rejects the call's promise. Where IndexedDB is missing, or throws when it is opened, each call rejects with `IndexedDB isn't available on this page, so mist-api:<id> can't be opened` or IndexedDB's own error. The next call tries again.
- If another page deletes or upgrades the database, mist closes its connection so that it isn't blocked, and opens the database again on the next call.

```ts
const seen = await mist.storage.update("seen", value => (typeof value === "number" ? value : 0) + 1);
await mist.storage.set("cache", { at: Date.now(), items });
```

`account(userId)` is a separate store for one Discord account, in the database `mist-api:<id>:account:<userId>`. Discord switches accounts without reloading the page, so data that belongs to an account, such as drafts or per-server state, goes in that account's store. Bind the store when you start work for an account, and bind again after a switch, so that a write that finishes after a switch still goes to the account it belongs to. `account` throws a `TypeError` for an empty or missing id.

```ts
import { currentUserId } from "@aurologic/mist-api/stores";

const userId = currentUserId();
if (userId) await mist.storage.account(userId).set("draft", text);
```

### mist.native

```ts
readonly native: NativeClient<N>;
```

Calls the plugin's native methods through `ctx.native.call`. Each method takes the native method's own arguments and returns a promise of its result. Electron's IPC structured-clones arguments and results on the way, so pass plain data.

```ts
const forecast: { temperature: number; } | null = await mist.native.lookup({ latitude: 48.86, longitude: 2.35 });
const sum: number = await mist.native.add(1, 2);
```

`NativeClient<N>` lists every method of `N` except `start`, `stop`, and the hidden `__mist_` methods that `defineNative` adds.

The page side records every call, with its arguments, outcome, and time taken, for `mist calls`. A call before `start` or after stop fails with the `mist.ctx` error, and the failure is recorded too.

`mist.native` is a `Proxy`. Its `then` is `undefined`, so `await mist.native` returns `mist.native` itself instead of treating it as a promise. Every other property name gives a calling function at runtime, so a method that the native side doesn't have fails only when the call reaches Evi. The type `N` is what catches a wrong name.

Errors keep their type when the native side is made with `defineNative` from mist-api 0.3 or later. A `NativeError` thrown there rejects the call with a `MistNativeError` with the same `code` and `data`, and an `HttpError` keeps its `status`. [NativeError](native.md#nativeerror) shows both sides. With an older or plain native side, a throw arrives as Electron makes it, a plain `Error` whose message starts with `Error invoking remote method`.

```ts
import { MistNativeError } from "@aurologic/mist-api";

try {
	await mist.native.readNote(name);
} catch (err) {
	if (err instanceof MistNativeError && err.code === "not-found") return null;
	throw err;
}
```

`mist.native.method.with({ signal })` returns the method with a signal. Aborting the signal rejects the call at once with the signal's reason. With a native side made with `defineNative` from mist-api 0.3 or later, it also aborts the method's `this.signal`, so the native work can stop. With another native side, the native method runs on and its answer is dropped. A signal that is already aborted rejects without calling the native side.

```ts
const controller = new AbortController();
const pending = mist.native.download.with({ signal: controller.signal })(url);
cancelButton.onclick = () => controller.abort();
```

The first call of each run asks the native side whether it speaks mist-api's call protocol, one extra call that isn't recorded. [How a call crosses IPC](native.md#how-a-call-crosses-ipc) explains it.

### mist.requests

```ts
readonly requests: MistRequests<RequestsOf<N>>;

interface MistRequests<R> {
	handle<K extends keyof R>(name: K, handler: (payload: Parameters<R[K]>[0]) => Awaited<ReturnType<R[K]>> | Promise<Awaited<ReturnType<R[K]>>>): () => void;
}
```

Answers the requests that the native side makes with [nativeRequests](native.md#nativerequests). `RequestsOf<N>` is the native module's request map, so the names and types come from `native.ts`. What `handler` returns or resolves with goes back to the waiting native code. A throw or rejection goes back as a failure with its message. Call `handle` while the plugin runs, as in `start`. Its handlers belong to the run and end with it. A second `handle` for a name replaces the first, and the returned function removes the handler.

```ts
mist.requests.handle("confirm", text => window.confirm(text));
```

The answer must survive a structured clone. One that doesn't is logged, and the native side gets a failure. The page starts polling for requests at the first `handle` of a run. A native side without requests support, older than mist-api 0.3 or not made with `defineNative`, gets no polls, and the page logs that once.

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

Records each line for `mist logs` and, while the plugin runs, prints it through the `ctx.logger` method of the same name. `log` is Vencord's `Logger.log`, for compat layers that port Vencord plugins. A line written while the plugin isn't running is only recorded. It isn't printed anywhere.

Arguments are recorded like call arguments. The page-wide handle shows every argument as its type and size, strings included. The CLI's view shows them whole, with fields named like secrets masked. `ctx.logger` also prints them to the page's console, where any plugin that wraps `console` can read them, so don't put a secret in a log string.

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

Publishes a value for `mist values`. The getter runs only when the CLI asks, never otherwise. If it throws, the value shows as `{ "error": "<message>" }`. A second `expose` with the same name replaces the getter.

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

Returns a version of `fn` that never throws. If `fn` throws, the wrapper returns the fallback and logs the error through `mist.log.error`, as in `lineText threw; returning its fallback`. It is for `$self` callbacks in source patches, which run inside Discord's code, where a throw breaks Discord's own rendering.

The fallback is a value or a function:

- A value is returned as it is.
- A function is called with the same `this` and arguments as `fn`, and its result is returned. Use it to fall back to Discord's own value, as in `line => line.text`. If the function throws too, the wrapper logs `<name>'s fallback threw; returning undefined` and returns `undefined`, so the result type includes `undefined`.
- A function is always called. If `fn` itself returns a function, such as a component, pass the fallback function inside another one: `() => Original`.

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
	// Falls back to Discord's own text, and logs the plugin's own line
	lineTitle: mist.safe(function lineTitle(line: { title?: string; }) {
		return line.title!.toUpperCase();
	}, line => line.title, { message: "Couldn't format the line title" }),
});
```

## Plugins that depend on each other

Two plugins that talk over the [bus](bus.md) break with no error when the user updates only one of them and the protocol version changed. `provides` and `needs` let mist-api find this and tell the user which plugin to update.

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

After each `start` of a plugin with `needs`, the wrapper looks up each needed plugin with `Evi.plugins.get` and reads its version of the protocol from its handle. It checks again whenever Evi's plugin list changes, which includes an install, an update, and turning a plugin on, until the run ends. A need is met when the versions are equal. Otherwise:

- If the other plugin provides an older version, or its handle doesn't say it provides the protocol, the warning says to update the other plugin. A plugin built with mist-api 0.2.1 or earlier, or without mist-api, never says what it provides.
- If the other plugin provides a newer version, the warning says to update this plugin.

The warning is printed through `mist.log.warn` and listed in `HandleState.warnings` while it applies. The user also gets a toast that names the plugin to update, as in `forecast-panel needs a newer version of Weather. Update Weather to use them together.` The log line and the toast happen once per need for each copy of the plugin, so once per Discord session unless the plugin is reloaded.

A needed plugin that isn't installed isn't checked, because a plugin may work without it. Neither is one that is turned off, because Evi doesn't run its code until it is turned on, so it hasn't said what it provides.

## onDemand

```ts
function onDemand<P extends object>(patch: P): P;
```

Marks a source patch whose module is in code Discord downloads only when a screen first opens, such as a settings screen or a video player. Until that code is downloaded, Evi finds no module for the patch and calls it broken. `mist status` and `mist patches` show a marked patch as waiting instead. A patch without the mark still shows as broken, so a patch whose code Discord removed is still reported. Once the module loads, Evi checks the patch as usual, and a match that no longer fits shows as failed or partial whether it's marked or not.

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

It sets a `$mistOnDemand` property on the patch object and returns the same object. Evi keeps the object it was given, so the mark reaches its diagnosis. Evi's own Patches tab doesn't read the mark and still shows such a patch as broken until its code is downloaded.

## The page registry

The first copy of mist-api to run `createMist` installs the page's debug registry under `Symbol.for("mist-api.registry.v1")`. Later copies join it. It also defines `window.Mist`, which every plugin and the CLI can read:

| Member | Returns |
| --- | --- |
| `Mist.version` | `1` |
| `Mist.list()` | `{ id, mistVersion, running }` for each registered plugin |
| `Mist.get(id)` | The plugin's `MistHandle`, or `undefined` |
| `Mist.status()` | Each plugin's `HandleState`, its start error from Evi, its registry history and concerns, and its patch and lookup health from `Evi.diagnosePatches` and `Evi.diagnoseLookups` |

The registry under the `Symbol.for` key also has `register(handle)`, `history(id)`, and `concerns(id)`. `history` counts how the id's handle changed hands: `registered`, `replaced`, `refused`, and `reclaimed`. `concerns` lists why the CLI shouldn't trust the handle, and is empty when nothing is wrong. [Security model](security.md#replacing-a-handle) explains both.

A `MistHandle` shows each value only as its type and size, as in `"object(2 keys)"` or `"string(12)"`. That includes log text and the message of a failed call. Its `call` always rejects. The whole view and calls live on the plugin's debug capability, which shows the page's records whole and gates calls on main's debugging port. The handle holds it in a private field, which only a CDP client can read. [Security model](security.md) explains the two views.

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

`provides` is the plugin's `provides` option. `warnings` lists what the plugin got wrong in the current run: a [store read too early](#stores-read-too-early), a [needed plugin at another version](#plugins-that-depend-on-each-other), a [settings migration](#settings-migrations) that threw, or a [`$self` name](#self-names) that the definition lacks. Both are absent from handles made by copies of 0.2.1 and earlier. Warnings aren't registry concerns: they don't make `mist call` refuse.

`owns(value)` is `true` only for the plugin's own `Mist` object, the one `createMist` made with this handle. `discord()` and the UI registries use it to check that the object they get is the plugin's own. It reveals nothing and calls nothing. Handles made by copies of 0.2.1 and earlier don't have it, so their `mist` can't own a registry entry or a `discord()` client.

`HandleState.native` is `"unknown"` until the plugin first starts. Then it is `"none"` for a plugin without a native module, `"plain"` for a native module not made with `defineNative`, and `"mist"` for one made with `defineNative`. `errors` counts the failed calls and the `error` lines still kept in the page side's rings. `quiet` counts the calls of each `quiet` method.

## Recorded values

Every recorded argument, result, exposed value, and setting is copied once, when it is recorded, into a JSON-safe `Snapshot`. Later changes to the object don't change the record. A snapshot has these limits:

- A string keeps its first 2000 characters, followed by a note of how many were cut.
- An array, a `Set`, or a `Map` keeps its first 50 items. A `Map` becomes an array of `[key, value]` pairs, and a value whose key is a secret name is masked.
- An object keeps its first 50 keys.
- Nesting stops at depth 6 with `"[too deep]"`, and a cycle shows as `"[circular]"`.
- `undefined` becomes `null`, a function becomes `"[function name]"`, a `bigint` becomes `"12n"`, a `Date` becomes its ISO string, and an `Error` becomes `{ error, message }`.

## Exported types

`@aurologic/mist-api` also exports these types: `Mist`, `MistOptions`, `MistLog`, `SafeOptions`, `MistDefinition`, `Migration`, `MigrationSettings`, `KeyValueStore`, `PluginStorage`, `Need`, `Provides`, `MistEvents`, `SubscribeOptions`, `EventsOf`, `EventsAnswer`, `NativeClient`, `MistCapability`, `MistHandle`, `HandleState`, `NativeKind`, `RegistryHistory`, `CallRecord`, `CallOutcome`, `LogRecord`, `LogLevel`, `NativeLogs`, `ReducedNativeLogs`, `Shown`, `Reduced`, and `Snapshot`. `Reduced` is a branded string, the type and size that a reduced view shows. `Shown` is `Snapshot | Reduced`, a value from a view that may or may not be open. `MIST_VERSION` is the version string of the copy, `"0.3.0"`. `SETTINGS_VERSION` is the settings key that holds the migrated version, `"__mist_settingsVersion"`.
