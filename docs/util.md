# Util

`@aurologic/mist-api/util` has small helpers that many plugins need. They work on the page side and on the native side. It imports nothing, and a plugin's bundle only carries the helpers it imports.

```ts
import { backoff, fetchJson, fetchWithTimeout, HttpError, isRecord, keepConnected, limit, parseSse, shared, sharedByKey, sleep, sseEvents, ttlCache, type WithDiscordNative } from "@aurologic/mist-api/util";
```

## isRecord

```ts
function isRecord(value: unknown): value is Record<string, unknown>;
```

`true` for any object that isn't `null` and isn't an array. That includes class instances, a `Map`, and a `Date`, not only plain objects. Use it to start validating data from outside, such as a native argument or a JSON body.

```ts
const raw: unknown = JSON.parse(text);
if (isRecord(raw) && typeof raw.name === "string") mist.log.info(raw.name);
```

## sleep

```ts
function sleep(ms: number, signal?: AbortSignal): Promise<void>;
```

Resolves after `ms` milliseconds. With a `signal`, it rejects with `signal.reason` if the signal aborts first, and at once if the signal has already aborted. It clears its timer on abort and removes its abort listener on resolve.

```ts
await sleep(500);
await sleep(5000, signal);
```

## fetchWithTimeout

```ts
interface TimedInit extends RequestInit {
	timeout?: number;
}

function fetchWithTimeout(url: string | URL, init?: TimedInit): Promise<Response>;
```

`fetch` that aborts after `timeout` milliseconds. The default is 10000. If `init.signal` is set, the request aborts on whichever comes first, that signal or the timeout. A timeout rejects with the `TimeoutError` `DOMException` from `AbortSignal.timeout`.

```ts
const res = await fetchWithTimeout("https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m", { timeout: 5000, headers: { accept: "application/json" } });
```

On the page side, Discord's Content-Security-Policy blocks `fetch` to hosts other than Discord's own. Call outside hosts from the native side.

## fetchJson

```ts
function fetchJson(url: string | URL, init?: TimedInit): Promise<unknown>;
```

Fetches with `fetchWithTimeout` and returns the parsed JSON body of a 2xx answer. Any other status throws an `HttpError`. The result is `unknown` on purpose, so validate it before use.

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

On the native side, check `err instanceof HttpError` and read `status`. An error from a native method reaches the page as a new `Error` from Electron's IPC, whose message contains the original one, so `instanceof HttpError` is `false` there. Match the message on the page side instead, as in `message.includes("HTTP 404")`.

## shared

```ts
function shared<T>(fn: () => Promise<T>): () => Promise<T>;
function sharedByKey<K extends string | number, A extends unknown[], T>(fn: (key: K, ...args: A) => Promise<T>): (key: K, ...args: A) => Promise<T>;
```

`shared` wraps a function so that only one run of it is in flight. A call while a run is in flight gets that run's promise and doesn't call `fn`. Once the run settles, resolved or rejected, the next call starts a new run. A failure is not kept: every caller of the failed run gets the rejection, and the next call tries again. `fn` can also throw synchronously; the call then rejects.

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

Delays for retries. Each `next()` gives the next delay in milliseconds and counts one attempt: `baseMs` (default 1000) the first time, then `factor` (default 2) times longer each time, never over `maxMs` (default 30000, or `baseMs` when that is longer). `reset()` starts again from `baseMs`, as after a success, and `attempts` is the number of delays since the start or the last reset.

`jitter`, from 0 to 1 (default 0.2), is the share of each delay that is random: with 0.2, a 10000 ms delay is from 8000 to 10000 ms. This keeps many clients that failed at the same time from all retrying at the same time. `random` replaces `Math.random`, for tests; a value outside 0 to 1 counts as 1. A negative or non-finite number, a `maxMs` under `baseMs`, a `factor` under 1, or a `jitter` outside 0 to 1 throws a `TypeError`.

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

Keeps a long-lived connection, such as an event stream or a WebSocket, up until `options.signal` aborts. It calls `connect(signal, connected)` and waits for it to settle, which is when the connection ends. It then waits the next `backoff` delay and calls `connect` again. `connect` calls `connected()` once the connection works, and that resets the backoff, so a connection that was healthy and then dropped is tried again after `baseMs`, and one that keeps failing waits longer each time.

Every run is followed by a delay, also one that returns at once, so the loop never spins. An error from `connect` goes to `onError` with its attempt number, counted from 1 since the last healthy connection, and never rejects the promise. An error thrown by `onError` is ignored. The promise resolves when the signal aborts: the wait in progress ends at once, and `connect` gets the same signal to close its connection. `backoff` takes options for `backoff()` or a `Backoff` of your own, and `sleep` replaces util's `sleep`, for tests. Without a `signal`, it rejects with a `TypeError`.

```ts
const life = lifetime(ctx);
void keepConnected(async (signal, connected) => {
	const res = await fetchWithTimeout("https://events.example.com/stream", { signal, timeout: 15_000, headers: { accept: "text/event-stream" } });
	if (!res.ok) throw new HttpError(res.status);
	connected();
	for await (const event of sseEvents(res, signal)) handle(event);
}, { signal: life.signal, onError: err => console.warn("The event stream dropped", err) });
```

The `timeout` of `fetchWithTimeout` also ends the stream after that long, so use plain `fetch` when a stream should stay open longer.

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

`sseEvents` reads a server-sent event stream (`text/event-stream`) from a fetch `Response` or its body and yields each event as it arrives. `event` is the event's `event:` field, or `"message"` when it has none. `data` is its `data:` lines joined with `"\n"`. `id` is its `id:` field, when it has one; it is not carried over to later events, so keep the last one yourself to send as `Last-Event-ID` when you reconnect.

It reads lines that end in CRLF, LF or CR, and decodes UTF-8 even when a character is split between two chunks. Comments (lines that start with `:`), `retry:` and unknown fields are skipped, and an event without data is not yielded, as in a browser's `EventSource`. An event the stream ends in the middle of is dropped. A `Response` without a body yields nothing.

The stream is cancelled when the loop stops early, by `break`, `return` or a throw, and when `signal` aborts. An abort makes the loop throw the signal's reason.

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

With `max`, setting a new key when the cache is full evicts the entry read or set longest ago. `get` counts as a use, `has` doesn't. Expired entries are removed when `get`, `has`, `delete` or `size` finds them; `size` counts only live entries. `delete` answers `true` when it removed a live entry. `now` replaces `Date.now`, for tests. A `ttlMs` that is neither a number nor a function, or a `max` that isn't a whole number above 0, throws a `TypeError`.

```ts
const forecasts = ttlCache<string, Forecast | null>({ ttlMs: f => f ? 3_600_000 : 60_000, max: 50 });
```

## limit

```ts
function limit(n: number): <T>(fn: () => Promise<T>) => Promise<T>;
```

Returns a `run` function that lets at most `n` of the functions given to it run at the same time. The others wait in the order they came, and each starts when a place frees. `run(fn)` resolves or rejects as `fn` does, and a failure frees its place like a success. `n` must be a whole number above 0, or it throws a `TypeError`.

With `sharedByKey`, it downloads each file once, two at a time:

```ts
const run = limit(2);
const download = sharedByKey((url: string) => run(() => fetchWithTimeout(url, { timeout: 30_000 }).then(res => res.blob())));
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

Types for Discord's desktop bridge. It is `undefined` in a browser and before Discord's preload has exposed it, and every member is optional, so check each one before you call it. Read it where you use it, not once at module load, because Evi can evaluate a plugin before the preload has run.

```ts
(window as WithDiscordNative).DiscordNative?.clipboard?.copy?.("copied text");
```

There is no accessor function on purpose. Evi's store review lists a plugin's desktop-bridge use by finding `DiscordNative.clipboard`, `DiscordNative.fileManager` and so on in its code. A helper function would hide those uses from reviewers, so write the property access in your plugin.
