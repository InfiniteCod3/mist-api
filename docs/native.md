# defineNative

`@aurologic/mist-api/native` is the native side of a plugin, the code in `native.ts` that runs in Discord's main process. It exports `defineNative`, `nativeEvents`, `nativeRequests`, `NativeError`, `log`, and `debugAllowed`, which this page covers, and the [native toolkit](toolkit.md): `discordWindow`, `lifetime`, `run`, `which`, `dataFolder`, `jsonFile`, `secrets`, and `pathGrants`.

```ts
import { debugAllowed, defineNative, log, NativeError, nativeEvents, nativeRequests } from "@aurologic/mist-api/native";
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
- `start`, which stores `ctx.pluginId` for log lines and then calls your `start` with `ctx`. Its `this` is the module with the run's `this.signal`. The module has a `start` even if `methods` has none.
- `stop`, which calls your `stop`, if `methods` has one, with the run's `this.signal` as in `start`. Then it aborts that signal and the `this.signal` of every call in flight, rejects every request still waiting for the page, and stops the event channel. The module has a `stop` even if `methods` has none.
- Hidden methods that the page side calls. `__mist_debugAllowed` and `__mist_logs` serve the debug gate and `mist native-logs`. `__mist_events` serves `mist.events`. `__mist_protocol` tells the page that this module answers [marked calls](#how-a-call-crosses-ipc). `__mist_abort` aborts a call, and `__mist_requests` and `__mist_reply` carry [requests](#nativerequests). `NativeClient` leaves them out of `mist.native`.

Members of `methods` that aren't functions are skipped.

`defineNative` reserves the `__mist_` prefix. A method whose name starts with `__mist_` makes it throw `Native method names starting with __mist_ are reserved: <name>`.

### Types

`NativeMethods<M>` gives `start` the type `(ctx: NativeContext) => void` and `stop` the type `() => void`, so `start(ctx)` needs no annotation. Every other method keeps the type you wrote.

The page infers `mist.native` from the method types. Write the parameter type you expect, such as `place: Place`, so the page side is typed. The type is a promise to the page and nothing more. The page is untrusted and IPC checks nothing, so validate every argument inside the method anyway.

`MistNative<M, E, R>` is `M` plus `start`, `stop`, and the hidden methods. `E` is the type of the event channel's events, and `R` is the map of requests that the native side makes. Pass `typeof native` to `createMist` as its second type parameter:

```ts
import type native from "./native";

export const mist = createMist<typeof settings, typeof native>("weather-demo");
```

### this

Inside a method, `this` is the returned module with one more member, `this.signal`, the call's own `AbortSignal`. A method can call another one through `this`, and that inner call is recorded too and gets the same `signal`. A value that a method stores on `this` is stored on the module, so the next call sees it:

```ts
export const counter = defineNative({
	count(): number { return 1; },
	twice(): number { return this.count() * 2; },
});
```

`this.signal` aborts in two cases:

- The page aborts the call, with `mist.native.method.with({ signal })(...args)`. This needs a page made with mist-api 0.3 or later.
- The native side stops. Every call in flight is aborted, with or without a page signal.

Pass it to whatever the method waits on:

```ts
export default defineNative({
	async download(url: string): Promise<number> {
		const response = await fetch(url, { signal: this.signal });
		return (await response.arrayBuffer()).byteLength;
	},
});
```

An arrow function has no `this`, so write a method that reads `this.signal` with method syntax.

In `start` and `stop`, `this.signal` is the run's signal. It aborts after `stop` returns, so work that `start` begins with it ends when the native side stops. A new `start` gets a new signal.

### NativeOptions

```ts
interface NativeOptions<M, E, R> {
	events?: NativeEvents<E>;
	requests?: NativeRequests<R>;
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
| `requests` | none | The requests from `nativeRequests` that the page answers with `mist.requests.handle`. [nativeRequests](#nativerequests) explains them. |
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

## NativeError

```ts
class NativeError<D = unknown> extends Error {
	constructor(code: string, data?: D, message?: string);
	readonly code: string;
	readonly data?: D;
}
```

Throw a `NativeError` from a native method to give the page a code to branch on. The page's call rejects with a `MistNativeError` that has the same `code`, `message`, and a structured clone of `data`. `message` defaults to `code`.

```ts
import { defineNative, NativeError } from "@aurologic/mist-api/native";
import { readFile } from "node:fs/promises";

export default defineNative({
	async readNote(name: string): Promise<string> {
		if (typeof name !== "string" || !/^[a-z0-9-]{1,40}$/.test(name)) throw new NativeError("bad-name", { name: String(name).slice(0, 40) }, "A note name is lowercase letters, digits and -");
		try {
			return await readFile(noteFile(name), "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new NativeError("not-found");
			throw err;
		}
	},
});
```

On the page:

```ts
import { MistNativeError } from "@aurologic/mist-api";

try {
	text = await mist.native.readNote(name);
} catch (err) {
	if (err instanceof MistNativeError && err.code === "not-found") text = "";
	else throw err;
}
```

Other errors cross too:

- An `HttpError` from `@aurologic/mist-api/util` reaches the page as an `HttpError` with the same `status`.
- Any other `Error` reaches the page as an `Error` with the same `name` and `message`, without Electron's `Error invoking remote method` prefix. Its stack and other fields stay on the native side.
- A thrown value that isn't an `Error` reaches the page as an `Error` whose message is the value as a string.

`data` must survive a structured clone. If it doesn't, such as an object holding a function, the error reaches the page without `data`. Don't put a secret in `data` or `message`: the page records failed calls for `mist calls`.

## How a call crosses IPC

Electron turns an error thrown in main into a plain `Error` whose message starts with `Error invoking remote method 'evi:plugin-native-call':`. To keep an error's type and to abort a call, mist-api adds a small protocol on top of Evi's `ctx.native.call`. Evi needs no change.

1. The first call of a page run asks the hidden `__mist_protocol` method. A module made with this `defineNative` answers `1`. Anything else, such as a module without `defineNative`, one made with mist-api 0.2.1 or earlier, or a failed call, counts as `0`. The answer is kept for the run.
2. With `1`, the page adds one last argument, a call mark, `{ __mist_call: 1, id }`. `id` is a random id when the call has a signal, and `null` otherwise.
3. `defineNative` removes the mark before your method and its record see the arguments. It answers `{ __mist_answer: 1, ok, value | error }` whatever the method does, so Electron never sees a throw.
4. The page unwraps the answer: it returns `value`, or throws the error rebuilt as the table above says.
5. If the page aborts the call, it rejects at once and calls `__mist_abort(id)`, which aborts the method's `this.signal`.

With `0`, the page calls as earlier versions did, without a mark. This decides what each pairing does:

| Page | Native side | Calls |
| --- | --- | --- |
| 0.3 or later | `defineNative` 0.3 or later | Marked. Errors keep their type, and an abort reaches `this.signal`. |
| 0.3 or later | `defineNative` 0.2.1 or earlier, or no `defineNative` | As before. Errors are Electron's prefixed `Error`. An abort rejects the page's call at once, and the native method runs on. |
| 0.2.1 or earlier | `defineNative` 0.3 or later | As before. A method sees exactly the page's arguments, and its errors are Electron's prefixed `Error`. `this.signal` aborts only when the native side stops. |
| No page side made with mist-api | `defineNative` 0.3 or later | As before. A call from Evi's `ctx.native.call` has no mark. |

A plain native module never sees a mark, so a method with a rest parameter, or one that counts its arguments, works as it did.

## nativeEvents

```ts
function nativeEvents<E>(options?: NativeEventsOptions<E>): NativeEvents<E>;
```

Makes an event channel from the native side to the page. Push events with `push(event)` and pass the channel to `defineNative` as `events`. The page reads it with `mist.events.subscribe`. [Events](events.md) covers its options, replay, restarts, and stop.

```ts
const events = nativeEvents<{ type: "saved"; id: string; }>({ keep: 500, replay: () => true });

export default defineNative({ /* ... */ }, { events });
```

## nativeRequests

```ts
function nativeRequests<R>(options?: NativeRequestsOptions): NativeRequests<R>;

interface NativeRequests<R> {
	request<K extends keyof R>(name: K, payload: Parameters<R[K]>[0], options?: RequestOptions): Promise<Awaited<ReturnType<R[K]>>>;
}
```

Lets native code ask the page and wait for the answer. `R` maps each request's name to a function type, the payload the page gets and the answer it gives. Pass the result to `defineNative` as `requests`. The page answers with `mist.requests.handle`, typed from the native module:

```ts
// native.ts
interface Asks {
	confirm(text: string): boolean;
}

const requests = nativeRequests<Asks>({ timeoutMs: 60_000 });

export default defineNative({
	async clearCache(): Promise<boolean> {
		const answer: unknown = await requests.request("confirm", "Delete the cached files?");
		if (answer !== true) return false;
		await rm(cacheFolder, { recursive: true, force: true });
		return true;
	},
}, { requests });
```

```ts
// index.tsx
mist.define({
	start() {
		mist.requests.handle("confirm", text => window.confirm(text));
	},
});
```

The answer comes from the page, so it is untrusted input whatever `R` says. Discord's page is shared with Discord's code and every other plugin, which can change what the handler sees and does, so check the answer's type and range before acting on it, as `answer !== true` does above. Never let an answer name a path, a program, or a URL that native code then uses without checking it.

| Option | Default | Effect |
| --- | --- | --- |
| `timeoutMs` | `30000` | How long a request waits for the page's answer. It must be more than 0. `request`'s own `timeoutMs` overrides it for one request. |

`request(name, payload, { timeoutMs, signal })` resolves with the page handler's answer. It rejects with the signal's reason when `signal` aborts, or with a `NativeError` whose code is one of these:

| Code | When |
| --- | --- |
| `request-timeout` | The page didn't answer within `timeoutMs`, as when the plugin's page side isn't running or has added no handler yet. |
| `request-unhandled` | The page side runs and has no handler for `name`. |
| `request-failed` | The page's handler threw or rejected. The message is the handler's error message, cut to 1000 characters. |
| `request-stopped` | The native side stopped before the page answered, or `request` was called while it was stopped. |

A request made before the page polls waits for it, until its timeout. A page that reloads gets the requests still waiting. Each request is answered once: a second answer for the same request is refused.

Requests ride a second event channel, `__mist_requests`, which the page long-polls as it does `__mist_events`, and the page answers through `__mist_reply`. Both are counted, not kept, in the call rings. The page polls only after a handler is added, and only when the native side answers `__mist_protocol`. Requests need mist-api 0.3 or later on both sides. A page that adds a handler for a native side without them logs once that the native side needs `defineNative` from mist-api 0.3 or later.

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
