# Native toolkit

`@aurologic/mist-api/native` also has helpers for what native sides do over and over: find Discord's window, run programs, clean up on stop, keep files, keep secrets, and take paths from a file dialog. Each one works with or without `defineNative`.

```ts
import { dataFolder, discordWindow, jsonFile, lifetime, pathGrants, run, secrets, which } from "@aurologic/mist-api/native";
```

Evi's build bundles only what a native side imports. A native side that imports only `defineNative` carries no `child_process`, `electron`, or file code, so Evi's review doesn't flag programs, files, or Electron in its `native.js`.

## discordWindow

```ts
function discordWindow(): BrowserWindow | undefined;
```

Returns Discord's main window, or `undefined` while there is none, before Discord opens it or after it closes. Discord's desktop core sets `global.mainWindowId`. When that window exists and shows Discord's app, it is the answer. Otherwise the answer is the first window that shows Discord's app: an `https:` page on `discord.com`, `ptb.discord.com`, or `canary.discord.com` that isn't the splash screen, the in-game overlay, or a popout.

Call it each time you need the window rather than keeping the answer, since a native side can start before Discord opens its window.

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

- It aborts `signal`, for `run`, `fetch`, and anything else that takes one.
- It clears every `interval` and `timeout`.
- It destroys every `window` that isn't destroyed yet.
- It ends every child from `spawn` that hasn't exited. It sends `SIGTERM`, and `SIGKILL` if the child is still running after `killAfterMs`. On Windows both end the process at once.

`interval` and `timeout` return a function that clears the timer sooner. `spawn` takes `node:child_process`'s options and returns its `ChildProcess`. It adds an `error` listener, so a program that fails to start doesn't throw in main. Add your own to hear about it.

After the stop, every method throws a `NativeError` with the code `stopped`. A new run needs a new scope, so make it in `start`, not at module load.

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

Runs a program without a shell, waits for it to exit, and collects its output as UTF-8. It resolves whatever the exit code is, so check `code`. `code` is `null` when a signal ended the program.

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
| `timeout` passes | A `NativeError` with the code `timeout` |
| `signal` aborts | The signal's reason |
| `stdout` or `stderr` passes `maxBytes` | A `NativeError` with the code `too-large` |

| Option | Default | Effect |
| --- | --- | --- |
| `timeout` | `60000` | How many ms the program may run. |
| `signal` | none | Aborting kills the program. Pass `this.signal` in a native method, or a lifetime's `signal`. |
| `cwd`, `env` | main's | The program's working folder and environment. |
| `input` | none | Written to the program's stdin, which is then closed. Without it, stdin is closed at once. |
| `maxBytes` | 10 MiB | The most bytes `stdout` and `stderr` may each hold. |
| `killAfterMs` | `3000` | How long the program gets after `SIGTERM` before `SIGKILL`. |

Arguments go to the program as they are, with no shell to split or expand them, so an argument from the page can't add a command. It can still be an option the program acts on, such as `--output=...`, so check arguments from the page. On Windows, Node can't run a `.cmd` or `.bat` file without a shell. Run `cmd.exe` with `["/d", "/s", "/c", file, ...args]` for one, and quote the arguments yourself.

## which

```ts
function which(name: string, env?: NodeJS.ProcessEnv): Promise<string | null>;
```

Returns the full path of the program that a shell would run for `name`, or `null` when there is none. It looks in each folder of `PATH` for a file it may run. On Windows a name without an extension is tried with each extension in `PATHEXT`. A name with a slash or backslash is checked as it is. `env` defaults to `process.env`.

## dataFolder

```ts
function dataFolder(ctx: NativeContext): string;
```

Returns the plugin's own folder, `<ctx.dataDir>/plugin-data/<plugin id>`, and makes it if it's missing. `ctx.dataDir` is Evi's data folder, which Evi and every plugin share. Its `plugins` folder holds installed plugins' code, so plugin data stays out of it. It throws for a plugin id that isn't a safe folder name.

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

A JSON file, `<name>.json` in the plugin's `dataFolder`, read once when it's made and then kept in memory. `get` returns the value in memory. `set` changes it at once and writes the file `debounceMs` later, so many sets in a row are one write. `flush` writes a pending change now. When the native side stops, a pending change is written before the stop ends, so a value set in `stop` is kept too.

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

Each write goes to a temporary file in the same folder, which is then renamed over the old file. A crash during a write leaves the old file or the new one, never half of one. A file that can't be read, can't be parsed, or that `parse` throws for is renamed to `<name>.json.bad` and logged, and the value starts from `initial`.

| Option | Default | Effect |
| --- | --- | --- |
| `initial` | required | The value when the file is missing or can't be read. |
| `parse` | type check | Turns what `JSON.parse` read into a `T`, or throws. Without it, the file's value is used when it has the same JSON type as `initial`: object, array, string, number, boolean, or null. |
| `maxBytes` | 5 MiB | The largest file read. A `set` whose JSON is larger throws a `RangeError` and changes nothing. |
| `debounceMs` | `500` | How many ms after a `set` the file is written. |

`name` is letters, digits, `_`, `.`, and `-`, and doesn't start with `.` or `mist-`. Names that start with `mist-` are mist-api's own. A failed write is logged with `log.error`, and the value stays in memory for the next write.

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

- It keeps a secret out of plain text on disk, so a copied or backed-up data folder doesn't give it away on its own.
- It doesn't keep a secret from other plugins. Every plugin's native code runs in the same main process, can call `safeStorage` too, and can read this file. A plugin with a native side can read every other plugin's secrets.
- `encrypted` is `false` when `safeStorage` can't encrypt at all, and on Linux without a keyring, where Electron falls back to a key built into Chromium (`basic_text`). Anyone who can read the file can decrypt a secret then. Tell the user, or don't store the secret.

`set` and `get` throw a `NativeError` with the code `secrets-unavailable` when `safeStorage` can't encrypt, and `get` throws `secret-unreadable` when a stored secret doesn't decrypt, as after the OS keyring changed. A name is 1 to 100 letters, digits, `_`, `.`, and `-`, or the call throws `bad-name`.

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

Paths that the user picked in a file dialog, given to the page as opaque handles. A native method that takes a path from the page lets any code that reaches the page's side make it read or write any path. A native method that takes a handle can only reach what the user picked.

```ts
let grants: PathGrants;

export default defineNative({
	start(ctx) {
		grants = pathGrants(ctx);
	},
	chooseExportFolder: (): Promise<GrantHandle | null> => grants.pickFolder({ title: "Export to" }),
	async exportTo(folder: GrantHandle, name: string): Promise<void> {
		await writeFile(grants.resolveGrant(folder, `${name}.json`), JSON.stringify(data()));
	},
});
```

- `pickFile` and `pickFolder` show Electron's open dialog over Discord's window. They resolve with a new handle, or `null` when the user cancels. `PickOptions` has `title`, `buttonLabel`, `defaultPath`, and `filters`, as Electron's dialog takes them.
- `resolveGrant(handle)` returns the picked path. For a folder, `segments` name a path inside it, joined as `path.resolve` does. A path that leads outside the folder, such as one with `..` or an absolute segment, throws a `NativeError` with the code `outside-grant`. A file grant takes no segments.
- `resolveGrant` throws `unknown-grant` for a value that isn't a handle this plugin gave out, or one that was revoked.
- `revokeGrant(handle)` forgets a handle, and returns `true` when it existed.

Handles are kept in `mist-grants.json` in the plugin's `dataFolder`, so a handle the page saved still works after Discord restarts. A handle lasts until it's revoked, so revoke one the plugin no longer needs. Each pick makes a new handle, even for a path picked before.

A handle limits which path native code reaches, not who asks. Any code that reaches the plugin's page side can pass a handle it has. `resolveGrant` checks the path's text and doesn't follow links: a symbolic link or junction inside a granted folder leads where it points.
