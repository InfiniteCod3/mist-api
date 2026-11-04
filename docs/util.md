# Util

`@aurologic/mist-api/util` has small helpers that many plugins need. They work on the page side and on the native side. It imports nothing, and a plugin's bundle only carries the helpers it imports.

```ts
import { fetchJson, fetchWithTimeout, HttpError, isRecord, sleep, type WithDiscordNative } from "@aurologic/mist-api/util";
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
