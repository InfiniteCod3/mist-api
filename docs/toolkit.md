# Native toolkit

`@aurologic/mist-api/native` also has helpers for what native sides do over and over: find Discord's window, run programs, clean up on stop, keep files, keep secrets, take paths from a file dialog, check the page's arguments, keep a site's login, and open links. Each one works with or without `defineNative`.

```ts
import { check, dataFolder, discordWindow, jsonFile, lifetime, loginWindow, openExternal, pathGrants, privateSession, run, secrets, which, writeAtomic, writeAtomicSync } from "@aurologic/mist-api/native";
```

Evi's build bundles only what a native side imports. A native side that imports only `defineNative` carries no `child_process`, `electron`, or file code, and Evi's review doesn't flag programs, files, or Electron in its `native.js`.

## discordWindow

```ts
function discordWindow(): BrowserWindow | undefined;
```

Returns Discord's main window, or `undefined` while there is none, before Discord opens it or after it closes. Discord's desktop core sets `global.mainWindowId`. When that window exists and shows Discord's app, it is the answer. Otherwise the answer is the first window that shows Discord's app: an `https:` page on `discord.com`, `ptb.discord.com`, or `canary.discord.com` that isn't the splash screen, the in-game overlay, or a popout.

Call it each time you need the window rather than keeping the answer: a native side can start before Discord opens its window.

```ts
const win = discordWindow();
if (win && !win.isFocused()) win.flashFrame(true);
```

## lifetime

```ts
function lifetime(ctx: NativeContext, options?: LifetimeOptions): Lifetime;

interface Lifetime {
	readonly signal: AbortSignal;
	spawn(file: string, args?: readonly string[], options?: SpawnOptions): ChildProcess;
	interval(fn: () => void, ms: number): () => void;
	timeout(fn: () => void, ms: number): () => void;
	window<W extends { isDestroyed(): boolean; destroy(): void; }>(win: W): W;
}
```

A scope for one run of the native side. What it starts ends when the run stops, through `ctx.onDispose`, which Evi runs on stop and on hot reload. Make one in `start`:

```ts
let life: Lifetime;

export default defineNative({
	start(ctx) {
		life = lifetime(ctx);
		life.interval(() => void poll(), 60_000);
	},
	startWatcher(): void {
		life.spawn("watcher", ["--json"], { stdio: "ignore" });
	},
});
```

On stop, the scope does these things:

- It aborts `signal`, for `run`, `fetch`, and anything else that takes one. The reason is a `DOMException` named `AbortError`, with the message `<plugin id>'s native side stopped`. Code that already ignores an `AbortError` from `fetch` ignores this one too.
- It clears every `interval` and `timeout`.
- It destroys every `window` that isn't destroyed yet.
- It ends every child from `spawn` that hasn't exited. It sends `SIGTERM`, and `SIGKILL` if the child is still running after `killAfterMs`. On Windows both end the process at once.

Evi doesn't stop native sides when Discord quits. The scope therefore also sends `SIGTERM` to every child from `spawn` that hasn't exited when Discord quits: on Electron's `will-quit`, and on Node's `exit` for Evi's restarts, which skip Electron's quit events. Main exits right after, and no `SIGKILL` follows. Timers and windows end with the process anyway.

`interval` and `timeout` return a function that clears the timer sooner. A callback that throws is logged with `log.error` instead of becoming an uncaught exception in Discord's main process, and an `interval` keeps running. A cleanup that throws on stop is logged too, and the other cleanups still run.

`spawn` takes `node:child_process`'s options and returns its `ChildProcess`. It adds an `error` listener, which keeps a program that fails to start from throwing in main; add a listener of yours to hear about it. On Windows, a `.cmd` or `.bat` file without the `shell` option throws a `NativeError` with the code `needs-shell`, as `run` does.

After the stop, every method throws a `NativeError` with the code `stopped`. A new run needs a new scope: make it in `start`, not at module load.

| Option | Default | Effect |
| --- | --- | --- |
| `killAfterMs` | `3000` | How long a child gets after `SIGTERM` before `SIGKILL`. |

## run

```ts
function run(file: string, args?: readonly string[], options?: RunOptions): Promise<RunResult>;

interface RunResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}
```

Runs a program without a shell, waits for it to exit, and collects its output as UTF-8. It resolves whatever the exit code is: check `code`. `code` is `null` when a signal ended the program.

```ts
const git = await which("git");
if (git) {
	const { code, stdout } = await run(git, ["rev-parse", "HEAD"], { cwd: repo, timeout: 10_000, signal: this.signal });
	if (code === 0) return stdout.trim();
}
```

It rejects in these cases, and kills the program first in each case except the first:

| Case | Rejects with |
| --- | --- |
| The program can't start | Node's error, such as one with the code `ENOENT` |
| On Windows, `file` is a `.cmd` or `.bat` file | A `NativeError` with the code `needs-shell` |
| `timeout` passes | A `NativeError` with the code `timeout` |
| `signal` aborts | The signal's reason |
| `stdout` or `stderr` passes `maxBytes` | A `NativeError` with the code `too-large` |

A rejection after the program exited doesn't wait for a child of the program that keeps its output open.

| Option | Default | Effect |
| --- | --- | --- |
| `timeout` | `60000` | How many ms the program may run. |
| `signal` | none | Aborting kills the program. Pass `this.signal` in a native method, or a lifetime's `signal`. |
| `cwd`, `env` | main's | The program's working folder and environment. |
| `input` | none | Written to the program's stdin, which is then closed. Without it, stdin is closed at once. |
| `maxBytes` | 10 MiB | The most bytes `stdout` and `stderr` may each hold. |
| `killAfterMs` | `3000` | How long the program gets after `SIGTERM` before `SIGKILL`. |

Arguments go to the program as they are, with no shell to split or expand them: an argument from the page can't add a command. It can still be an option the program acts on, such as `--output=...`. Check arguments from the page.

On Windows, Node starts a `.cmd` or `.bat` file only through a shell, and without one fails with a bare `EINVAL`. `run` and `lifetime().spawn` check first and throw `needs-shell`, with a message that says what to do: run `cmd.exe` with `["/d", "/s", "/c", file, ...args]` and quote the arguments for `cmd` yourself, or pass `lifetime().spawn` the option `shell: true`. Both let `cmd` parse the arguments. Never pass page input through them unchecked.

## which

```ts
function which(name: string, env?: NodeJS.ProcessEnv): Promise<string | null>;
```

Returns the full path of the program that a shell would run for `name`, or `null` when there is none. It looks in each folder of `PATH` for a file it may run. On Windows a name without an extension is tried with each extension in `PATHEXT`, and `PATH` and `PATHEXT` are found whatever their case, as in `Path`. A name with a slash or backslash is checked as it is. `env` defaults to `process.env`.

## dataFolder

```ts
function dataFolder(ctx: NativeContext): string;
```

Returns the plugin's data folder, `<ctx.dataDir>/plugin-data/<plugin id>`, and makes it if it's missing. `ctx.dataDir` is Evi's data folder, which Evi and every plugin share. Its `plugins` folder holds installed plugins' code, and plugin data stays out of it. It throws for a plugin id that isn't a safe folder name.

Every plugin's native code can read every plugin's folder. It's a place to keep files apart, not a lock.

## jsonFile

```ts
function jsonFile<T>(ctx: NativeContext, name: string, options: JsonFileOptions<T>): JsonFile<T>;

interface JsonFile<T> {
	readonly path: string;
	get(): T;
	set(value: T | ((current: T) => T)): void;
	flush(): Promise<void>;
}
```

A JSON file, `<name>.json` in the plugin's `dataFolder`, read once when it's made and then kept in memory.

- `get` returns the value in memory.
- `set` changes it at once and writes the file `debounceMs` later. Many sets in a row make one write.
- `flush` writes a pending change now.

A pending change is also written on stop, before the stop ends, which keeps a value set in `stop` too. Evi doesn't stop native sides when Discord quits. `jsonFile` therefore also writes a pending change, synchronously, on Electron's `will-quit` and on Node's `exit`, which Evi's restarts reach without `will-quit`. Each run of the native side adds one listener for each and removes them when it stops: hot reloads don't pile them up.

Every `jsonFile` of the same name in one run of the native side is the same object, made with the first call's options. Two of them share the value and the writes instead of overwriting each other. `secrets` and `pathGrants` share their files the same way. A new run reads the file again.

```ts
interface Prefs {
	volume: number;
}

let prefs: JsonFile<Prefs>;

export default defineNative({
	start(ctx) {
		prefs = jsonFile(ctx, "prefs", {
			initial: { volume: 50 },
			parse: raw => isRecord(raw) && typeof raw.volume === "number" ? { volume: raw.volume } : { volume: 50 },
		});
	},
	setVolume(volume: number): void {
		if (typeof volume !== "number" || !(volume >= 0 && volume <= 100)) throw new NativeError("bad-volume");
		prefs.set({ volume });
	},
});
```

Each write goes through [`writeAtomicSync`](#writeatomic-and-writeatomicsync): a crash during a write leaves the old file or the new one, never half of one.

A file that can't be parsed, or that `parse` throws for, is renamed to `<name>.json.bad` and logged, and the value starts from `initial`. If the rename fails, the file counts as unreadable, as below, and no write replaces it. A missing file starts from `initial` too.

A file that exists but can't be read is left as it is, because its data may be fine. It may be locked by another program (`EBUSY`, `EPERM`), not readable (`EACCES`), or over `maxBytes`. `get` and `set` then throw a `NativeError` with the code `file-unreadable` that names the file and the reason, and no write replaces the file. Each of them tries the read again first: the file works again once it can be read.

| Option | Default | Effect |
| --- | --- | --- |
| `initial` | required | The value when the file is missing or can't be parsed. |
| `parse` | type check | Turns what `JSON.parse` read into a `T`, or throws. Without it, the file's value is used when it has the same JSON type as `initial`: object, array, string, number, boolean, or null. |
| `maxBytes` | 5 MiB | The largest file read. A larger file is left alone, and `get` and `set` throw `file-unreadable`. A `set` whose JSON is larger throws a `RangeError` and changes nothing. |
| `debounceMs` | `500` | How many ms after a `set` the file is written. |

`name` is letters, digits, `_`, `.`, and `-`, and doesn't start with `.` or `mist-`; names that start with `mist-` are mist-api's. A failed write is logged with `log.error`, and the value stays in memory for the next write.

## writeAtomic and writeAtomicSync

```ts
function writeAtomic(path: string, content: string | Uint8Array): Promise<void>;
function writeAtomicSync(path: string, content: string | Uint8Array): void;
```

The write that `jsonFile` uses, for any other file. Each writes `content` to a temporary file next to `path`, then renames it over `path`: a reader sees the old file or the new one, never half of one. A string is written as UTF-8, and a `Uint8Array` as its bytes. On failure, each removes the temporary file and throws, or rejects with, what the write or rename threw.

Use `writeAtomic` in a native method: it doesn't block Discord's main process while the file is written. `writeAtomicSync` is for places that can't wait, such as a `will-quit` or `exit` handler.

```ts
await writeAtomic(join(dataFolder(ctx), "export.csv"), rows.join("\n"));
writeAtomicSync(join(dataFolder(ctx), "cover.png"), pngBytes);
```

## secrets

```ts
function secrets(ctx: NativeContext): Secrets;

interface Secrets {
	readonly encrypted: boolean;
	get(name: string): string | undefined;
	set(name: string, value: string): void;
	delete(name: string): boolean;
}
```

Strings kept encrypted with Electron's `safeStorage` in `mist-secrets.json` in the plugin's `dataFolder`. Each `set` and `delete` is written without a debounce.

```ts
const vault = secrets(ctx);
if (!vault.encrypted) log.warn("No OS keyring: the API key is stored with Chromium's built-in key");
vault.set("apiKey", key);
```

Know what this protects against before you rely on it:

- It keeps a secret out of plain text on disk. A copied or backed-up data folder doesn't give it away by itself.
- It doesn't keep a secret from other plugins. Every plugin's native code runs in the same main process, can call `safeStorage` too, and can read this file. A plugin with a native side can read every other plugin's secrets.
- `encrypted` is `false` when `safeStorage` can't encrypt at all, and on Linux without a keyring, where Electron falls back to a key built into Chromium (`basic_text`). Anyone who can read the file can then decrypt a secret. Tell the user, or don't store the secret.

`set` and `get` throw a `NativeError` with the code `secrets-unavailable` when `safeStorage` can't encrypt. `get` throws `secret-unreadable` when a stored secret doesn't decrypt, as after the OS keyring changed. A name is 1 to 100 letters, digits, `_`, `.`, and `-`, or the call throws `bad-name`. Like a [`jsonFile`](#jsonfile), every call throws `file-unreadable` while `mist-secrets.json` exists but can't be read. `pathGrants` does the same for `mist-grants.json`.

Never return a secret to the page, which shares its JavaScript with Discord and every other plugin. Use it in native code, such as in a request's headers.

## pathGrants

```ts
function pathGrants(ctx: NativeContext): PathGrants;

interface PathGrants {
	pickFile(options?: PickOptions): Promise<GrantHandle | null>;
	pickFolder(options?: PickOptions): Promise<GrantHandle | null>;
	resolveGrant(handle: unknown, ...segments: unknown[]): string;
	revokeGrant(handle: unknown): boolean;
}
```

Paths that the user picked in a file dialog, given to the page as opaque handles. A native method that takes a path from the page lets any code that reaches the page side read or write any path. A native method that takes a handle can only reach what the user picked.

```ts
let grants: PathGrants;

export default defineNative({
	start(ctx) {
		grants = pathGrants(ctx);
	},
	chooseExportFolder: (): Promise<GrantHandle | null> => grants.pickFolder({ title: "Export to" }),
	async exportTo(folder: GrantHandle, name: string): Promise<void> {
		await writeAtomic(grants.resolveGrant(folder, `${name}.json`), JSON.stringify(data()));
	},
});
```

- `pickFile` and `pickFolder` show Electron's open dialog over Discord's window. They resolve with a new handle, or `null` when the user cancels. `PickOptions` has `title`, `buttonLabel`, `defaultPath`, and `filters`, as Electron's dialog takes them.
- `resolveGrant(handle)` returns the picked path. For a folder, `segments` name a path inside it, joined as `path.resolve` does. A path that leads outside the folder, such as one with `..` or an absolute segment, throws a `NativeError` with the code `outside-grant`. A file grant takes no segments.
- `resolveGrant` throws `unknown-grant` for a value that isn't a handle this plugin gave out, or one that was revoked.
- `revokeGrant(handle)` forgets a handle, and returns `true` when it existed.

Handles are kept in `mist-grants.json` in the plugin's `dataFolder`. A handle the page saved still works after Discord restarts. A handle lasts until it's revoked: revoke one the plugin no longer needs. Each pick makes a new handle, even for a path picked before.

A handle limits which path native code reaches, not who asks. Any code that reaches the plugin's page side can pass a handle it has. `resolveGrant` checks the path's text and doesn't follow links: a symbolic link or junction inside a granted folder leads where it points.

## check

```ts
const check: {
	text(value: unknown, options: { max: number; min?: number; name?: string; }): string;
	id(value: unknown, name?: string): string;
	int(value: unknown, options: { min: number; max: number; name?: string; }): number;
	bool(value: unknown, name?: string): boolean;
	oneOf<const T>(value: unknown, list: readonly T[], name?: string): T;
	https(value: unknown, options?: { hosts?: readonly string[]; name?: string; }): URL;
	list<T>(value: unknown, item: (value: unknown, name: string) => T, options: { max: number; name?: string; }): T[];
	record(value: unknown, name?: string): Record<string, unknown>;
};
```

Guards for the arguments a native method gets from the page. TypeScript types a method's parameters for the page side, but nothing checks them across IPC, and any code on the page can call the method with anything.

Each guard returns the value with its type, or throws a `NativeError` with the code `bad-argument` and `data` of `{ name, expected }`, as in `{ name: "city", expected: "a string of 1 to 100 characters" }`. The message is `<name> must be <expected>`. The page's call rejects with a `MistNativeError` with the same code and data. `name` defaults to `"value"`.

- `text` takes a string of `min` (default 0) to `max` characters.
- `id` takes a Discord id: a string of 1 to 20 digits.
- `int` takes a whole number from `min` to `max`, both included.
- `bool` takes `true` or `false`, not a truthy value.
- `oneOf` takes a value that is `===` to an item of `list`, and returns it typed as the list's item type.
- `https` takes an https URL of at most 8192 characters, without a user name or password, and returns it parsed. With `hosts`, the host must be one of them. `"example.com"` is that host only, and `"*.example.com"` is any host under it but not `example.com` itself: list both for both.
- `list` takes an array of at most `max` items and checks each with `item`, which gets the item's name as `name[i]`. The error names the item that failed. A guard such as `check.id` can be the `item`.
- `record` takes an object that isn't `null` or an array, to read fields from. Check each field you read.

```ts
export default defineNative({
	async forecast(rawCity: unknown, rawDays: unknown, rawUnits: unknown) {
		const city = check.text(rawCity, { min: 1, max: 100, name: "city" });
		const days = check.int(rawDays, { min: 1, max: 14, name: "days" });
		const units = check.oneOf(rawUnits, ["metric", "imperial"] as const, "units");
		return fetchJson(`https://api.example.com/forecast?city=${encodeURIComponent(city)}&days=${days}&units=${units}`);
	},
});
```

## privateSession

```ts
function privateSession(ctx: NativeContext, name: string, options?: { browserUserAgent?: boolean; }): PrivateSession;

interface PrivateSession {
	readonly session: Session;
	readonly partition: string;
	fetch(url: string | URL, init?: RequestInit): Promise<Response>;
	json(url: string | URL, init?: TimedInit): Promise<unknown>;
	cookie(url: string, name: string): Promise<string | undefined>;
	hasCookie(url: string, name: string): Promise<boolean>;
	clear(): Promise<void>;
	flush(): Promise<void>;
}
```

A login to another site, kept apart from Discord's. It is an Electron session on the partition `persist:mist:<plugin id>:<name>`, which Electron keeps on disk: the login lasts across restarts. The site never gets Discord's cookies, and Discord's pages never get the site's. `name` is 1 to 40 lowercase letters, digits, and `-`, or the call throws a `TypeError`. A call with the same name gives the same Electron session.

Every permission request and permission check from the session's pages is denied: camera, microphone, notifications, clipboard, and the rest. To allow one, set a handler on `session` after the call. Some sites refuse a login from a browser that says it is Electron. `browserUserAgent: true` takes the `Electron/...` and `discord/...` tokens out of the session's user agent, which then reads as Chrome's.

- `fetch` is Electron's `session.fetch`: it sends the session's cookies and keeps the ones the site sets.
- `json` is `fetchJson` through the session's `fetch`, with a timeout, `timeout` in `init`, 10000 ms by default. It returns the parsed body of a 2xx answer and throws util's `HttpError` for any other status.
- `cookie(url, name)` is the value of the cookie `name` that the session would send to `url`, or `undefined`. `hasCookie` says whether there is one, which tells you whether the user is signed in.
- `clear` signs out of everything: it removes the session's cookies, storage, and cache, and the storage of the pre-0.5 partition described below.
- `flush` writes the cookies to disk now. Electron otherwise writes them some time later, and a crash before then loses a new login. `loginWindow` flushes when it ends.

```ts
let site: PrivateSession;

export default defineNative({
	start(ctx) {
		site = privateSession(ctx, "music", { browserUserAgent: true });
	},
	signedIn: () => site.hasCookie("https://music.example.com", "session"),
	nowPlaying: () => site.json("https://music.example.com/api/now-playing"),
	signOut: () => site.clear(),
});
```

### Logins from before 0.5

Before 0.5 the partition was `persist:<plugin id>-<name>`, which two plugins could share: plugin `a` with the name `b-c`, and plugin `a-b` with the name `c`. The first `privateSession` call for a name after Discord starts moves the old login into the new partition. Every helper above, and `loginWindow`, waits for the move first.

- The move runs only while the new partition has no cookies.
- Cookies move one at a time. One that fails to move is logged and skipped, and the others still move. Each moved cookie is removed from the old partition: a later sign-out stays signed out.
- When the move ends, mist-api writes the empty file `mist-session-<name>.migrated` in the plugin's `dataFolder`. With that file present, later starts skip the move.
- When another installed plugin's id could have made the same old partition name, as plugin `a-b` could for `a` with `b-c`, the old partition may hold that plugin's login. mist-api leaves it alone, logs a warning that the user has to sign in again, and writes the marker file.
- A move that fails as a whole is logged as a warning and tried again at the next start. The user may have to sign in again.

## loginWindow

```ts
function loginWindow(session: PrivateSession | Session, options: LoginWindowOptions): Promise<boolean>;

interface LoginWindowOptions {
	url: string;
	done(url: string): boolean | Promise<boolean>;
	signal?: AbortSignal;
	title?: string;
	width?: number;
	height?: number;
	pollMs?: number;
}
```

Shows a site's login page in a window of the private session and waits for the user to sign in. The window is centred over Discord's, `width` by `height` (480 by 720 by default), and shows once the page is ready. With `title`, the page can't change the window's title. The window has no Node, no preload, and context isolation, and runs sandboxed. Popups are denied, and a navigation or redirect to anything but https is stopped. `url` must be https, `width` and `height` positive whole numbers, and `pollMs` above 0 up to the [timer limit](util.md#timer-limits), or the call throws a `TypeError` or `RangeError`.

`done` is asked with the page's URL after each navigation, and every `pollMs` (1000 by default) for a login that finishes without one. The promise resolves `true` the first time `done` answers `true`. It resolves `false` when the user closes the window or `signal` aborts. A `done` that throws or rejects is asked again later, and the first error is logged. The window loads `url` once the session's cookie move is done. Either way, the window is destroyed and the session's cookies are flushed to disk before the promise resolves.

One window is open per session. A call while one is open focuses that window, restores it if it is minimized, and returns its promise; the second call's options are not used. Pass `this.signal` or a lifetime's `signal`: the window then closes when the call is aborted or the native side stops.

```ts
async connect(): Promise<boolean> {
	return loginWindow(site, {
		url: "https://music.example.com/login",
		title: "Sign in to the music service",
		done: () => site.hasCookie("https://music.example.com", "session"),
		signal: this.signal,
	});
},
```

## openExternal

```ts
function openExternal(url: unknown, options?: { hosts?: readonly string[]; }): Promise<void>;
```

Opens a link in the user's browser with Electron's `shell.openExternal`. The link must be an https URL, checked as `check.https` checks it, with `hosts` if given. Anything else rejects with a `NativeError` `bad-argument`. Electron's shell also opens files, programs, and other protocols. A native method that passed a link from the page straight to it would let the page start any of them.

```ts
openDocs: (link: unknown) => openExternal(link, { hosts: ["docs.example.com"] }),
```
