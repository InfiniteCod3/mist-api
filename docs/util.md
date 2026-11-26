# Util

`@aurologic/mist-api/util` has small helpers that many plugins need. They work on the page side and on the native side. The module imports nothing, and a plugin's bundle carries only the helpers it imports.

```ts
import { backoff, debounce, fetchJson, fetchWithTimeout, HttpError, isRecord, isSnowflake, keepConnected, limit, parseSse, shared, sharedByKey, sleep, sseEvents, ttlCache, until, type WithDiscordNative, withTimeout } from "@aurologic/mist-api/util";
```

## Timer limits

Every helper here that takes a time in milliseconds checks it before it starts a timer: `sleep`, `fetchWithTimeout`, `withTimeout`, `until`, `debounce`, and `backoff`. So do `mist.flux.next`'s `timeout` and `nativeRequests`' `timeoutMs`.

- A time above 2147483647 ms (2³¹ − 1, about 24.8 days), the longest `setTimeout` takes, is out of range. `setTimeout` would fire a longer one at once, which is why the helpers refuse it instead.
- A value that isn't a number, or is `NaN`, throws a `TypeError`.
- A number out of range, infinite, or negative throws a `RangeError`.

Each message starts with the helper and the option's name, as in `sleep: ms must be a finite number from 0 to 2147483647, got -1`. A helper that returns a promise, such as `withTimeout`, rejects with the error instead of throwing it. The limit isn't exported; mist-api calls it `MAX_TIMEOUT_MS` internally.

## isRecord

```ts
function isRecord(value: unknown): value is Record<string, unknown>;
```

`true` for any object that isn't `null` and isn't an array. That includes class instances, a `Map`, and a `Date`, not only plain objects. Use it to start validating data from outside, such as a native argument or a JSON body.

```ts
const raw: unknown = JSON.parse(text);
if (isRecord(raw) && typeof raw.name === "string") mist.log.info(raw.name);
```

## isSnowflake

```ts
function isSnowflake(value: unknown): value is string;
```

`true` for a string of 1 to 20 digits: the shape of a Discord id. A number is never one, because Discord's ids are larger than a JavaScript number holds exactly. It has no other dependency and works on the native side.

On the page, use [`snowflake.is`](discord.md#snowflake) from `@aurologic/mist-api/discord` instead. It also refuses 20-digit strings above 2⁶⁴ − 1, which no Discord id can be, and comes with `snowflake.assert`, `time`, `at`, and `compare`.

```ts
if (isSnowflake(rawUserId)) cache.delete(rawUserId);
```

## sleep

```ts
function sleep(ms: number, signal?: AbortSignal): Promise<void>;
```

Resolves after `ms` milliseconds. With a `signal`, it rejects with `signal.reason` if the signal aborts first, and at once if the signal has already aborted. It clears its timer on abort and removes its abort listener on resolve. `ms` follows the [timer limits](#timer-limits).

```ts
await sleep(500);
await sleep(5000, signal);
```

## fetchWithTimeout

```ts
interface TimedInit extends RequestInit {
	timeout?: number;
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

function fetchWithTimeout(url: string | URL, init?: TimedInit): Promise<Response>;
```

`fetch` that aborts after `timeout` milliseconds, 10000 by default, within the [timer limits](#timer-limits). If `init.signal` is set, the request aborts on whichever comes first, that signal or the timeout. A timeout rejects with the `TimeoutError` `DOMException` from `AbortSignal.timeout`.

`init.fetch` sends the request in place of the global `fetch`, called with the URL as a string. Pass an Electron session's `fetch`, bound to its session, to send that session's cookies; [`privateSession`](toolkit.md#privatesession)'s `json` does this.

```ts
const res = await fetchWithTimeout("https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m", { timeout: 5000, headers: { accept: "application/json" } });
```

On the page side, `fetchWithTimeout` and `fetchJson` use the page's `fetch`, and Discord's Content-Security-Policy blocks every host but Discord's. Call outside hosts from `native.ts`, as the [example plugin](../README.md#example) does, and pass the result to the page.

## fetchJson

```ts
function fetchJson(url: string | URL, init?: TimedInit): Promise<unknown>;
```

Fetches with `fetchWithTimeout` and returns the parsed JSON body of a 2xx answer. Any other status throws an `HttpError`. The result is `unknown` on purpose: validate it before use.

```ts
try {
	const body = await fetchJson("https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m");
	if (!isRecord(body)) throw new Error("Unexpected answer");
} catch (err) {
	if (err instanceof HttpError && err.status === 404) return null;
	throw err;
}
```

## HttpError

```ts
class HttpError extends Error {
	readonly status: number;
}
```

The error `fetchJson` throws for a status outside 2xx. `name` is `"HttpError"` and `message` is `"HTTP <status>"`, as in `"HTTP 404"`.

An `HttpError` thrown in a native method made with `defineNative` reaches the page as an `HttpError` with the same `status`, and `err instanceof HttpError` works on both sides. A native side without `defineNative`, or from mist-api 0.2.1 or earlier, gives the page Electron's plain `Error` instead, whose message contains `HTTP <status>`. [NativeError](native.md#nativeerror) lists how each error crosses.

## shared

```ts
function shared<T>(fn: () => Promise<T>): () => Promise<T>;
function sharedByKey<K extends string | number, A extends unknown[], T>(fn: (key: K, ...args: A) => Promise<T>): (key: K, ...args: A) => Promise<T>;
```

`shared` wraps a function to keep only one run of it in flight. A call while a run is in flight gets that run's promise and doesn't call `fn`. Once the run settles, resolved or rejected, the next call starts a new run. A failure is not kept: every caller of the failed run gets the rejection, and the next call tries again. If `fn` throws synchronously, the call rejects.

`sharedByKey` does the same per key. A call gets the run in flight for its first argument, a string or a number, and otherwise starts a run with all its arguments. The arguments after the key of a call that joins a run are not used. Runs for different keys go on at the same time.

Neither keeps results. To keep a result after its run, put it in a `ttlCache`.

```ts
const refreshToken = shared(() => fetchJson("https://auth.example.com/token", { method: "POST" }));
const readProfile = sharedByKey((userId: string) => fetchJson(`https://api.example.com/users/${userId}`));
```

## backoff

```ts
interface BackoffOptions {
	baseMs?: number;
	maxMs?: number;
	factor?: number;
	jitter?: number;
	random?: () => number;
}

interface Backoff {
	next(): number;
	reset(): void;
	readonly attempts: number;
}

function backoff(options?: BackoffOptions): Backoff;
```

Delays for retries. Each `next()` gives the next delay in milliseconds and counts one attempt: `baseMs` (default 1000) the first time, then `factor` (default 2) times longer each time, never over `maxMs` (default 30000, or `baseMs` when that is longer). `reset()` starts again from `baseMs`, as after a success. `attempts` is the number of delays since the start or the last reset.

`jitter`, from 0 to 1 (default 0.2), is the share of each delay that is random: with 0.2, a 10000 ms delay is from 8000 to 10000 ms. Many clients that failed together then don't all retry together. `random` replaces `Math.random`, for tests; a value outside 0 to 1 counts as 1.

`baseMs` and `maxMs` follow the [timer limits](#timer-limits). A `maxMs` under `baseMs`, a `factor` under 1, or a `jitter` outside 0 to 1 throws a `RangeError`, and an option that isn't a number throws a `TypeError`.

```ts
const delays = backoff({ baseMs: 2000, maxMs: 60_000 });
for (;;) {
	try {
		return await fetchJson("https://api.example.com/forecast");
	} catch {
		await sleep(delays.next(), signal);
	}
}
```

## keepConnected

```ts
interface KeepConnectedOptions {
	signal: AbortSignal;
	backoff?: BackoffOptions | Backoff;
	onError?(err: unknown, attempt: number): void;
	sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

function keepConnected(connect: (signal: AbortSignal, connected: () => void) => Promise<unknown> | unknown, options: KeepConnectedOptions): Promise<void>;
```

Keeps a long-lived connection, such as an event stream or a WebSocket, up until `options.signal` aborts. It calls `connect(signal, connected)` and waits for it to settle, which is when the connection ends. It then waits the next `backoff` delay and calls `connect` again.

`connect` calls `connected()` once the connection works, which resets the backoff. A connection that was healthy and then dropped is tried again after `baseMs`; one that keeps failing waits longer each time.

- Every run is followed by a delay, also one that returns at once: the loop never spins.
- An error from `connect` goes to `onError` with its attempt number, counted from 1 since the last healthy connection, and never rejects the promise. An error thrown by `onError` is ignored.
- The promise resolves when the signal aborts. The wait in progress ends at once, and `connect` gets the same signal to close its connection.
- `backoff` takes options for `backoff()` or a `Backoff` you made. `sleep` replaces util's `sleep`, for tests.
- Without a `signal`, it throws a `TypeError`.

```ts
const life = lifetime(ctx);
void keepConnected(async (signal, connected) => {
	const res = await fetch("https://events.example.com/stream", { signal, headers: { accept: "text/event-stream" } });
	if (!res.ok) throw new HttpError(res.status);
	connected();
	for await (const event of sseEvents(res, signal)) handle(event);
}, { signal: life.signal, onError: err => console.warn("The event stream dropped", err) });
```

Use plain `fetch` for a stream, as above. The `timeout` of `fetchWithTimeout` would end the stream after that long.

## Server-sent events

```ts
interface SseEvent {
	event: string;
	data: string;
	id?: string;
}

function sseEvents(source: Response | ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent>;
function parseSse(buffer: string): { events: SseEvent[]; rest: string; };
```

`sseEvents` reads a server-sent event stream (`text/event-stream`) from a fetch `Response` or its body and yields each event as it arrives. `event` is the event's `event:` field, or `"message"` when it has none. `data` is its `data:` lines joined with `"\n"`. `id` is its `id:` field, when it has one. It is not carried over to later events: keep the last one to send as `Last-Event-ID` when you reconnect.

It reads lines that end in CRLF, LF, or CR, and decodes UTF-8 even when a character is split between two chunks. Comments (lines that start with `:`), `retry:`, and unknown fields are skipped, and an event without data is not yielded, as in a browser's `EventSource`. An event the stream ends in the middle of is dropped. A `Response` without a body yields nothing.

The stream is cancelled when the loop stops early, by `break`, `return`, or a throw, and when `signal` aborts. An abort makes the loop throw the signal's reason.

`parseSse` is the parser `sseEvents` uses. It reads the complete events at the start of `buffer` and returns the text after the last complete event as `rest`. Add the next chunk to `rest` and parse again.

```ts
const res = await fetch("https://events.example.com/stream", { signal, headers: { accept: "text/event-stream" } });
for await (const { event, data } of sseEvents(res, signal)) {
	if (event === "forecast") show(JSON.parse(data));
}
```

## ttlCache

```ts
interface TtlCacheOptions<V> {
	ttlMs: number | ((value: V) => number);
	max?: number;
	now?: () => number;
}

interface TtlCache<K, V> {
	get(key: K): V | undefined;
	set(key: K, value: V): void;
	has(key: K): boolean;
	delete(key: K): boolean;
	clear(): void;
	readonly size: number;
}

function ttlCache<K, V>(options: TtlCacheOptions<V>): TtlCache<K, V>;
```

A `Map` whose entries expire. Each entry lives `ttlMs` milliseconds from its `set`. `ttlMs` can be a function of the value, to keep a found result longer than a miss. A time of 0 or less stores nothing and removes the key, and `Infinity` keeps the entry until it is evicted or deleted.

With `max`, setting a new key when the cache is full evicts the entry read or set longest ago. `get` counts as a use, `has` doesn't. Expired entries are removed when `get`, `has`, `delete`, or `size` finds them; `size` counts only live entries. `delete` answers `true` when it removed a live entry. `now` replaces `Date.now`, for tests.

A `ttlMs` that is neither a number nor a function throws a `TypeError`, as does a `max` that isn't a number. A `max` that isn't a whole number above 0 throws a `RangeError`.

```ts
const forecasts = ttlCache<string, Forecast | null>({ ttlMs: f => f ? 3_600_000 : 60_000, max: 50 });
```

## limit

```ts
function limit(n: number): <T>(fn: () => Promise<T>) => Promise<T>;
```

Returns a `run` function that lets at most `n` of the functions given to it run at the same time. The others wait in the order they came, and each starts when a place frees. `run(fn)` resolves or rejects as `fn` does, and a failure frees its place like a success. An `n` that isn't a number throws a `TypeError`, and one that isn't a whole number above 0 a `RangeError`.

With `sharedByKey`, it downloads each file once, two at a time:

```ts
const run = limit(2);
const download = sharedByKey((url: string) => run(() => fetchWithTimeout(url, { timeout: 30_000 }).then(res => res.blob())));
```

## debounce

```ts
interface DebounceOptions {
	signal?: AbortSignal;
	flushOnAbort?: boolean;
}

type Debounced<A extends unknown[]> = ((...args: A) => void) & {
	flush(): void;
	cancel(): void;
};

function debounce<A extends unknown[]>(fn: (...args: A) => void, delay: number | "frame", options?: DebounceOptions): Debounced<A>;
```

Wraps `fn` to run it once for a burst of calls, with the last call's arguments. With a number, `fn` runs once no call has come for `delay` milliseconds. With `"frame"`, it runs on the next animation frame after the last call, for work that redraws.

- `flush()` runs the pending call now, if there is one.
- `cancel()` drops the pending call.
- With `signal`, an abort drops the pending call, and calls after the abort are ignored. With `flushOnAbort: true`, the abort runs the pending call instead of dropping it.
- The abort listener sits on `signal` only while a call is pending. A long-lived signal doesn't collect a listener for every debounced call.
- A `"frame"` delay waits 16 ms instead of a frame where frames don't come: on the native side, which has no `requestAnimationFrame`, and while the page is hidden, where Chromium sends no frames until it shows again.

A `delay` that is neither `"frame"` nor a number throws a `TypeError`. A number follows the [timer limits](#timer-limits).

```ts
start() {
	const signal = mist.signal;
	const search = debounce((query: string) => void runSearch(query, signal), 300, { signal });
	searchBox.addEventListener("input", () => search(searchBox.value), { signal });
	const redraw = debounce(render, "frame", { signal });
	mist.flux.on("PRESENCE_UPDATES", () => redraw());
},
```

## withTimeout

```ts
function withTimeout<T>(work: Promise<T> | ((signal: AbortSignal) => Promise<T>), ms: number, options?: AbortSignal | { signal?: AbortSignal }): Promise<T>;
```

Settles as `work` does, or rejects with a `TimeoutError` `DOMException` after `ms` milliseconds, or with the signal's reason when it aborts first. Pass the signal bare or as `{ signal }`.

When `work` is a function, it is called with a signal that aborts on the timeout or on the given signal, and the work can stop. A promise can't be stopped: it runs on, and its result is dropped.

It rejects at once when the signal has already aborted. An `ms` outside the [timer limits](#timer-limits) rejects with a `TypeError` or `RangeError`.

```ts
const answer = await withTimeout(inner => fetch(url, { signal: inner }).then(res => res.json()), 5000, mist.signal);
```

## until

```ts
interface UntilOptions {
	timeout?: number;
	every?: number;
	signal?: AbortSignal;
}

function until(check: () => boolean | Promise<boolean>, options: UntilOptions): Promise<boolean>;
```

Calls `check` until it returns `true`, and resolves `true`, or until `timeout` milliseconds pass, and resolves `false`. It waits `every` milliseconds between checks, 50 by default. `check` can be async.

- Pass `timeout`, `signal`, or both. Without either, `until` rejects with a `TypeError` at once: it could otherwise wait forever. Without `timeout`, only `signal` ends the wait.
- It rejects with `signal`'s reason when `signal` aborts, and with any error `check` throws. Only its own timeout resolves `false`: a `TimeoutError` that `check` throws, or that is `signal`'s reason, still rejects.
- `timeout` and `every` follow the [timer limits](#timer-limits), and `every` must be above 0.

```ts
const ready = await until(() => document.querySelector("[class^=sidebar_]") !== null, { timeout: 10_000, signal: mist.signal });
```

## DiscordNative types

```ts
interface DiscordNativeBridge {
	window?: { focus?(): void; };
	clipboard?: { copy?(text: string): void; };
	fileManager?: { saveWithDialog?(data: Uint8Array, filename: string): Promise<string | undefined>; };
}

type WithDiscordNative = { DiscordNative?: DiscordNativeBridge; };
```

Types for Discord's desktop bridge. It is `undefined` in a browser and before Discord's preload has exposed it, and every member is optional: check each one before you call it. Read it where you use it, not once at module load, because Evi can evaluate a plugin before the preload has run.

```ts
(window as WithDiscordNative).DiscordNative?.clipboard?.copy?.("copied text");
```

There is no accessor function on purpose. Evi's store review lists a plugin's desktop-bridge use by finding `DiscordNative.clipboard`, `DiscordNative.fileManager`, and so on in its code. A helper function would hide those uses from reviewers. Write the property access in your plugin.
