# createMist

`@aurologic/mist-api` is the page side of a plugin. It exports `createMist`, `onDemand`, the `MIST_VERSION` constant, and the types listed at the end of this page. `mist.events` is the page side of the [event channel](events.md).

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
}
```

| Option | Default | Effect |
| --- | --- | --- |
| `secrets` | `[]` | Field names and `Map` key names masked in recorded arguments, results, exposed values, and settings, on top of the built-in names. Each is a whole name, not a pattern. Matching ignores case. |
| `reveal` | `[]` | Field names and `Map` key names shown even though a built-in name would mask them, such as `sessionId` for an id that isn't a credential. Each is a whole name. Matching ignores case. A name in `secrets` stays masked. |
| `secretArgs` | `{}` | For each native method, the positions of arguments masked in its recorded calls, counting from 0. For a secret passed as a bare string. Only `N`'s methods can be named. |
| `quiet` | `[]` | Native methods whose calls are counted and not kept, such as a long poll that would push every other call out of the ring. A call of one that fails is kept like any other. `HandleState.quiet` and `mist status` show the counts. Only `N`'s methods can be named. |
| `capacity` | `200` | How many native calls the page side keeps, and how many log lines. Each has its own ring of this size. It must be a positive integer. |

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
	define(definition: PluginDefinition<S>): PluginDefinition<S>;
	expose(name: string, getter: () => unknown): void;
	safe<A extends unknown[], R>(fn: (...args: A) => R, fallback: (...args: A) => R, options?: SafeOptions): (...args: A) => R | undefined;
	safe<A extends unknown[], R>(fn: (...args: A) => R, fallback: R, options?: SafeOptions): (...args: A) => R;
}
```

### mist.define

```ts
define(definition: PluginDefinition<S>): PluginDefinition<S>;
```

Wraps the plugin's definition. Use it in place of `definePlugin` and export its result as the default export.

The returned definition is a copy of `definition` with a wrapped `start`. The wrapper does three things before it calls your `start` with the same `this` and context:

1. It sets the context that `mist.ctx` returns.
2. It registers a dispose callback on the context that clears `mist.ctx`. The callback only clears it if the context is still the current one, so a late dispose from an earlier run doesn't clear a newer run.
3. It asks the native side whether Discord's main process has a debugging port. The first answer is kept. A rejected call is asked again on the next debug request. [Security model](security.md) explains this check.

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
	mist.ctx.toast("still here");
}
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
	state(): HandleState;
	logs(n?: number): LogRecord<Reduced>[];
	calls(n?: number): CallRecord<Reduced>[];
	nativeLogs(n?: number): Promise<ReducedNativeLogs | null>;
	values(): Record<string, Reduced>;
	settings(): Record<string, Reduced> | null;
	call(method: string, ...args: unknown[]): Promise<never>;
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
}
```

`HandleState.native` is `"unknown"` until the plugin first starts. Then it is `"none"` for a plugin without a native module, `"plain"` for a native module not made with `defineNative`, and `"mist"` for one made with `defineNative`. `errors` counts the failed calls and the `error` lines still kept in the page side's rings. `quiet` counts the calls of each `quiet` method.

## Recorded values

Every recorded argument, result, exposed value, and setting is copied once, when it is recorded, into a JSON-safe `Snapshot`. Later changes to the object don't change the record. A snapshot has these limits:

- A string keeps its first 2000 characters, followed by a note of how many were cut.
- An array, a `Set`, or a `Map` keeps its first 50 items. A `Map` becomes an array of `[key, value]` pairs, and a value whose key is a secret name is masked.
- An object keeps its first 50 keys.
- Nesting stops at depth 6 with `"[too deep]"`, and a cycle shows as `"[circular]"`.
- `undefined` becomes `null`, a function becomes `"[function name]"`, a `bigint` becomes `"12n"`, a `Date` becomes its ISO string, and an `Error` becomes `{ error, message }`.

## Exported types

`@aurologic/mist-api` also exports these types: `Mist`, `MistOptions`, `MistLog`, `SafeOptions`, `MistEvents`, `SubscribeOptions`, `EventsOf`, `EventsAnswer`, `NativeClient`, `MistCapability`, `MistHandle`, `HandleState`, `NativeKind`, `RegistryHistory`, `CallRecord`, `CallOutcome`, `LogRecord`, `LogLevel`, `NativeLogs`, `ReducedNativeLogs`, `Shown`, `Reduced`, and `Snapshot`. `Reduced` is a branded string, the type and size that a reduced view shows. `Shown` is `Snapshot | Reduced`, a value from a view that may or may not be open. `MIST_VERSION` is the version string of the copy, `"0.2.0"`.
