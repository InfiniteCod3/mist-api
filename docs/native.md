# defineNative

`@aurologic/mist-api/native` is the native side of a plugin, the code in `native.ts` that runs in Discord's main process. It exports `defineNative`, `nativeEvents`, `log`, and `debugAllowed`.

```ts
import { debugAllowed, defineNative, log, nativeEvents } from "@aurologic/mist-api/native";
```

## How Evi runs a native module

Evi loads `native.js` in Discord's main process and keeps its default export as the module. When the page calls `ctx.native.call(method, ...args)`, Evi runs `fn.apply(module, args)` for the exported function named `method`. `start` and `stop` are lifecycle hooks and the page can't call them. Arguments and results cross Electron's IPC, so they are structured-cloned.

Two limits shape what mist-api does here:

- Main can't push to the page. The page asks, and main answers. [Events](events.md) builds a channel from main to the page on top of this.
- Native `console` output goes to the main process's stdout. A CDP client attached to the page doesn't see it. That is why `log` keeps native log lines in a ring that `mist native-logs` fetches.

## defineNative

```ts
function defineNative<M extends Record<string, (...args: any[]) => unknown>, E = never>(
	methods: NativeMethods<M>,
	options?: NativeOptions<M, E>,
): MistNative<M, E>;
```

Wraps a native module. Export its result as the default export of `native.ts`.

```ts
import { defineNative, log } from "@aurologic/mist-api/native";
import { fetchJson, HttpError, isRecord } from "@aurologic/mist-api/util";

export interface Place {
	latitude: number;
	longitude: number;
}

export interface Forecast {
	temperature: number;
}

export default defineNative({
	start(ctx) {
		log.info("native side up in", ctx.dataDir);
	},

	async lookup(place: Place): Promise<Forecast | null> {
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
}, { secrets: ["licenseKey"] });
```

The returned module has these members:

- Each method of `methods`, wrapped so that its calls are recorded with arguments, outcome, and time taken. A returned promise is recorded when it settles. A throw is recorded and thrown again.
- `start`, which stores `ctx.pluginId` for log lines and then calls your `start` with the same `this` and `ctx`. The module has a `start` even if `methods` has none.
- `stop`, which calls your `stop`, if `methods` has one, and then stops the event channel. The module has a `stop` even if `methods` has none.
- Three hidden methods, `__mist_debugAllowed`, `__mist_logs`, and `__mist_events`. The page side calls them for the debug gate, for `mist native-logs`, and for `mist.events`. `NativeClient` leaves them out of `mist.native`.

Members of `methods` that aren't functions are skipped.

`defineNative` reserves the `__mist_` prefix. A method whose name starts with `__mist_` makes it throw `Native method names starting with __mist_ are reserved: <name>`.

### Types

`NativeMethods<M>` gives `start` the type `(ctx: NativeContext) => void` and `stop` the type `() => void`, so `start(ctx)` needs no annotation. Every other method keeps the type you wrote.

The page infers `mist.native` from the method types. Write the parameter type you expect, such as `place: Place`, so the page side is typed. The type is a promise to the page and nothing more. The page is untrusted and IPC checks nothing, so validate every argument inside the method anyway.

`MistNative<M, E>` is `M` plus `start`, `stop`, and the three hidden methods. `E` is the type of the event channel's events. Pass `typeof native` to `createMist` as its second type parameter:

```ts
import type native from "./native";

export const mist = createMist<typeof settings, typeof native>("weather-demo");
```

### this

Inside a method, `this` is the returned module, because Evi calls `fn.apply(module, args)`. A method can call another one through `this`, and that inner call is recorded too:

```ts
export const counter = defineNative({
	count(): number { return 1; },
	twice(): number { return this.count() * 2; },
});
```

### NativeOptions

```ts
interface NativeOptions<M, E> {
	events?: NativeEvents<E>;
	secrets?: readonly string[];
	reveal?: readonly string[];
	secretArgs?: { [method in keyof M]?: readonly number[] };
	quiet?: readonly (keyof M)[];
	capacity?: number;
}
```

| Option | Default | Effect |
| --- | --- | --- |
| `events` | none | The channel from `nativeEvents` that the page reads with `mist.events.subscribe`. [Events](events.md) explains it. |
| `secrets` | `[]` | Field names and `Map` key names masked in recorded arguments and results, on top of the built-in names that [createMist](core.md#mistoptions) lists. |
| `reveal` | `[]` | Field names and `Map` key names shown even though a built-in name would mask them. A name in `secrets` stays masked. |
| `secretArgs` | `{}` | For each method, the positions of arguments masked in its recorded calls, counting from 0, as in `{ login: [1] }`. Only the module's own methods can be named. |
| `quiet` | `[]` | Methods whose calls are counted and not kept. A call of one that fails is kept like any other. `__mist_logs` answers with the counts, and `mist native-logs` prints them. |
| `capacity` | `200` | How many calls the native side keeps, and how many log lines. It must be a positive integer. |

The native side records separately from the page side. Give it the same `secrets`, `reveal`, `secretArgs`, and `quiet` as `createMist`.

### The native ring

`defineNative` makes the native side's ring of calls and log lines, with its own `secrets` and `capacity`. It runs once per native bundle. A second call throws, because `log` records into the ring that the first call made.

A `log` line that runs before `defineNative`, such as one at module load in a file that `native.ts` imports, is printed at once and held until `defineNative` runs. Then it is recorded with `defineNative`'s options, at the time it was written. Up to 200 such lines are held, and older ones are dropped.

The ring also decides once whether it keeps values whole. It keeps them whole only if main has a debugging port, as `debugAllowed()` reports. Without a port, every argument, result, log argument, and error message is reduced to its type and size when it is recorded, and nothing else is ever held in memory. Restarting Discord with a port is the only way to see native values whole.

Each plugin's native bundle carries its own copy of mist-api, so each ring records one plugin. It isn't private, though. Every native module runs in the same main process with full access, so another plugin's native code can reach this module and call `__mist_logs` itself.

## nativeEvents

```ts
function nativeEvents<E>(options?: NativeEventsOptions<E>): NativeEvents<E>;
```

Makes an event channel from the native side to the page. Push events with `push(event)` and pass the channel to `defineNative` as `events`. The page reads it with `mist.events.subscribe`. [Events](events.md) covers its options, replay, restarts, and stop.

```ts
const events = nativeEvents<{ type: "saved"; id: string; }>({ keep: 500, replay: () => true });

export default defineNative({ /* ... */ }, { events });
```

## log

```ts
const log: {
	log(...args: unknown[]): void;
	debug(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
};
```

Logs from native code. Each line goes into the native ring for `mist native-logs` and is printed to main's stdout as `[<plugin id>] ...`. Each level prints with the `console` method of the same name. Until the module's `start` runs, the prefix is `[mist]`.

String arguments are values like any other. Main's stdout is the only place they are printed, and the page never sees it. So without a debugging port they are reduced to type and size when they are recorded, and with one `mist native-logs` shows them whole. Don't put a secret in a log string.

```ts
log.info("native side up in", ctx.dataDir);
```

## debugAllowed

```ts
function debugAllowed(argv?: readonly string[]): boolean;
```

Returns `true` if `argv` contains `--remote-debugging-port` or `--remote-debugging-pipe`, alone or followed by `=`. `argv` defaults to `process.argv`, which in `native.ts` is the argv of Discord's main process. `--remote-debugging-portal` and `--inspect` don't count.

```ts
debugAllowed(["discord.exe", "--remote-debugging-port=9222"]); // true
```

The hidden `__mist_debugAllowed` method answers with `debugAllowed()`. [Security model](security.md) explains why the answer comes from main.
