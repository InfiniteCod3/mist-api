# Testing

`@aurologic/mist-api/testing` has test doubles for a plugin's unit tests: a fake plugin context, a fake Flux store, a fake Flux dispatcher, a fake `@evi/api` module, and a fake `electron` module. They work with any test runner. The module imports no runner, nothing at runtime from `@evi/api`, and not Electron, so it loads in Bun, Vitest, Jest, or plain Node.

```ts
import { fakeContext, fakeDispatcher, fakeElectron, fakeEvi, fakeStore } from "@aurologic/mist-api/testing";
```

A plugin never bundles it. Import it only from test files.

## Mock @evi/api

Evi's build provides `@evi/api` when it bundles a plugin, so it doesn't exist when a test runs. Code that imports it, including `@aurologic/mist-api/stores`, needs a module mock. `fakeEvi()` makes the mock's module object:

```ts
// Bun
import { mock } from "bun:test";
import * as React from "react";
import { fakeEvi } from "@aurologic/mist-api/testing";

const evi = fakeEvi({ React });
mock.module("@evi/api", () => evi.module);
const { default: plugin } = await import("./index");
```

```ts
// Vitest
import { vi } from "vitest";
import plugin from "./index";

const evi = await vi.hoisted(async () => {
	const { fakeEvi } = await import("@aurologic/mist-api/testing");
	return fakeEvi({ React: await import("react") });
});
vi.mock("@evi/api", () => evi.module);
```

Bun applies `mock.module` only to imports that come after it, so import the code under test with a dynamic `import()`. Vitest moves `vi.hoisted` and `vi.mock` above the file's imports, so a `vi.hoisted` callback imports what it needs itself. Leave out `React` when nothing under test reads it from `@evi/api`.

`evi.module` has these members:

| Member | Does |
| --- | --- |
| `findStore(name)` | Returns the store added under `name`, or `undefined`. Throws while `evi.ready` is `false`, as Evi's does before Discord's webpack has loaded. |
| `getStore(name)` | Like `findStore`, but throws when there is no such store. |
| `filters.byStoreName(name)` | A filter that takes the store added under `name`. |
| `waitFor(filter, callback)` | Calls back at once with a store the filter takes. Otherwise it calls back when `evi.addStore` adds one. Returns a function that stops the wait. |
| `find(filter)`, `findAll(filter)` | The first, or every, added store or export the filter takes. A filter that throws counts as not taking the value, as in Evi. |
| `I18n` | `{ discordLocale: "en-US" }`. Set `discordLocale` to test another language. |
| `Dispatcher` | A `fakeDispatcher()`. |
| `React` | The `React` passed to `fakeEvi`. Reading it throws when none was passed, and then it isn't enumerable, so spreading the module object leaves it out. |
| `Components` | Evi's components, empty, so the `Button` and `Tip` of `@aurologic/mist-api/ui` render their own fallback. Set `Button` or `Tooltip` on it to render a stand-in for Discord's. |

`evi` itself controls the fake:

| Member | Does |
| --- | --- |
| `addStore(name, store)` | Adds a store, and calls back each waiting `waitFor` whose filter takes it. This is how a test makes a store arrive late, as Discord makes many stores after a plugin starts. |
| `removeStore(name)` | Removes a store. |
| `addExport(value)` | Adds a module export that `find` and `findAll` search, as Evi's search Discord's webpack exports. |
| `ready` | While `false`, `findStore` and `getStore` throw. `true` by default. |
| `lookups` | Each name `findStore` and `getStore` were asked for, oldest first. |

The fake has every export that mist-api's own code imports from `@evi/api`. Only the members above exist. Code that uses another export of `@evi/api`, such as `showToast` or `filters.byProps`, needs the test to add it to the module object:

```ts
mock.module("@evi/api", () => ({ ...evi.module, showToast: () => { } }));
```

## fakeStore

```ts
function fakeStore<T extends object>(state: T): FakeStore<T>;
```

Makes a Flux store from `state`: the object itself, with `addChangeListener`, `removeChangeListener`, the set of `listeners`, and `change(next)`. `change` assigns `next` to the store and then calls each listener, as a Flux store's `emitChange` does.

```ts
import { subscribe } from "@aurologic/mist-api/stores";

test("redraws when the presence changes", () => {
	const presence = fakeStore({ status: "online", getStatus() { return this.status; } });
	evi.addStore("PresenceStore", presence);
	let redraws = 0;
	const unsubscribe = subscribe("PresenceStore", () => redraws++);
	presence.change({ status: "idle" });
	expect(redraws).toBe(1);
	unsubscribe();
	expect(presence.listeners.size).toBe(0);
});
```

## fakeDispatcher

```ts
function fakeDispatcher(): FakeDispatcher;
```

Makes a Flux dispatcher with `subscribe`, `unsubscribe`, and `dispatch`. `dispatch(action)` calls each handler subscribed to `action.type` before it returns, and adds the action to `dispatched`. `fakeEvi` and `fakeContext` each make one, so a test rarely needs this.

## fakeContext

```ts
function fakeContext<S extends SettingsSchema = SettingsSchema>(options?: FakeContextOptions<S>): FakeContext<S>;
```

Makes the context that Evi passes to a plugin's `start`, typed as Evi's `PluginContext<S>`, and records what the plugin does with it:

```ts
import plugin from "./index";

test("starts, logs, and cleans up", async () => {
	const run = fakeContext({ id: "weather-demo", schema: plugin.settings, settings: { units: "metric" } });
	await plugin.start!(run.ctx);
	expect(run.logs).toContainEqual({ level: "info", args: ["started"] });
	run.dispose();
	expect(run.styles).toEqual([]);
});
```

The options:

| Option | Default | Effect |
| --- | --- | --- |
| `id` | `"test"` | The plugin id: `ctx.id`, and `ctx.manifest.id` and `name`. |
| `schema` | `{}` | The settings schema, for the defaults of `ctx.settings.get` and `ctx.settings.all`. |
| `settings` | `{}` | Stored setting values. `ctx.settings.set` writes into this object, so passing it to the next `fakeContext` starts again with the same settings, as after a restart. |
| `native` | none | Answers `ctx.native.call(method, ...args)`. Without it, `ctx.native.call` throws `<id> has no native module`, as Evi's does for a plugin without a native module. |
| `evi` | a new `fakeEvi()` | The fake `@evi/api` that `ctx.waitFor` and `ctx.flux` use. Pass the one the module mock returns, so that both see the same stores and dispatcher. |
| `overrides` | none | Replaces members of the context. |

What the context does:

| Member | Fake |
| --- | --- |
| `logger` | Adds each call to `logs` as `{ level, args }`. Nothing is printed. |
| `settings` | `get`, `set`, `all`, `snapshot`, `onChange`, and `use`. `set` calls the `onChange` callbacks whose values changed. `use` needs the `evi` made with `React`. |
| `onDispose(fn)` | Keeps `fn` for `dispose()`. After `dispose()`, it runs `fn` at once, as Evi does for a plugin that has stopped. |
| `waitFor(filter, callback)` | Waits through `evi.module.waitFor`. `dispose()` stops the wait. |
| `flux.subscribe(type, handler)` | Subscribes through `evi.module.Dispatcher`. A handler that throws is logged as an error, not thrown. `dispose()` unsubscribes. |
| `flux.dispatch(action)` | Dispatches through `evi.module.Dispatcher`. |
| `native.call(method, ...args)` | Calls the `native` option. `mist.native` first calls `__mist_protocol` once per run; a `native` that doesn't answer it with a number gets calls as Evi passes them, with no call mark. |
| `addStyle(css)` | Adds the CSS to `styles` until `remove()` or `dispose()`. `update(css)` replaces it. |
| `toast(message)` | Adds the message to `toasts`. |
| `setInterval`, `setTimeout` | Real timers that `dispose()` clears. |
| `hook`, `hookExport`, `contextMenu`, `command`, `panelToggle`, `profileBadges`, `keybind` | Throw, and name the override to pass. |

`fakeContext` returns:

| Member | Holds |
| --- | --- |
| `ctx` | The context. |
| `logs` | What the plugin logged through `ctx.logger`, oldest first. Cleanup errors and errors from Flux handlers are logged here too. |
| `styles` | The CSS of each `ctx.addStyle` that is still applied. |
| `toasts` | What the plugin passed to `ctx.toast`. |
| `evi` | The fake `@evi/api` the context uses. |
| `dispose()` | What Evi does when the plugin stops: runs the disposers, newest first. A disposer that throws is logged and the rest still run. |
| `disposed` | Whether `dispose()` has run. |

To fake a member that the context only stubs, pass it in `overrides`:

```ts
const hooked: string[] = [];
const run = fakeContext({
	overrides: { hook: { after: (_target: object, key: string) => { hooked.push(key); return () => { }; } } },
});
```

Evi's `PluginContext` is a class with private fields, so no other object matches its type. `fakeContext` casts its plain object to `PluginContext<S>`. A test that reads a member the fake doesn't have gets `undefined` at runtime, even though the type says it exists.

### Testing discord() and the UI registries

`discord(mist)` and the registries in `@aurologic/mist-api/ui` take only a `mist` that `mist.define` registered, and look the plugin up in `window.Evi.plugins` to read its manifest's `permissions`. A test starts the plugin with a fake context and puts a stand-in for `Evi.plugins` on `globalThis`:

```ts
(globalThis as any).Evi = { plugins: { get: (id: string) => id === "weather-demo" ? { manifest: { id, permissions: { readMessages: true } } } : undefined } };
const definition = mist.define({});
const run = fakeContext({ id: "weather-demo" });
definition.start!(run.ctx);
messages.beforeSend(mist, "trim", draft => { draft.content = draft.content.trim(); });
```

Leave out `permissions` for a plugin that declares none.

## Mock electron

```ts
function fakeElectron(options?: FakeElectronOptions): FakeElectron;
```

Electron's main-process module only exists inside Electron, so a native side's unit tests need a module mock of `electron`. `fakeElectron()` makes the mock's module object, and the parts of it that mist-api's native toolkit and most native sides use:

```ts
// Bun
import { mock } from "bun:test";
import { fakeElectron } from "@aurologic/mist-api/testing";

const electron = fakeElectron({ fetch: url => url.endsWith("/now") ? Response.json({ title: "A song" }) : new Response("", { status: 404 }) });
mock.module("electron", () => electron.module);
const { default: native } = await import("./native");
```

`electron.module` has these members:

| Member | Fake |
| --- | --- |
| `BrowserWindow` | A constructor: `new BrowserWindow(options)` makes a window that records `options` and every `loadURL`. `getAllWindows()` lists the windows not destroyed, `fromId(id)` finds one, and `getFocusedWindow()` is the last one focused. |
| `session` | `fromPartition(partition)` gives one session per partition, and `defaultSession` is the session of `""`. Each session's `fetch` is answered by the fake's `fetch` and recorded in `fetched`. It has a cookie jar (`cookies.get`, `set`, `remove`, `flushStore`, and the `changed` event), records its permission handlers, keeps a user agent, and `clearStorageData()` empties the jar. |
| `shell` | `openExternal(url)` adds `url` to `opened`. |
| `dialog` | `showOpenDialog`, `showSaveDialog`, and `showMessageBox` answer `dialogAnswers.open`, `.save`, and `.message`, and add `{ kind, parent, options }` to `dialogCalls`. |
| `safeStorage` | A reversible stand-in for encryption, so `secrets` can be tested. It throws while `encryptionAvailable` is `false`. |
| `app` | An `EventEmitter`, so `app.emit("will-quit")` is Discord quitting, with `getPath(name)` and `getVersion()`. |

A window from the fake is an `EventEmitter` with Electron's window methods (`focus`, `show`, `minimize`, `restore`, `getBounds`, `destroy`, and more) and test helpers:

- `navigate(url)` is the page going to `url`. It emits `will-navigate` on `webContents` with an event the code can `preventDefault`, and when the code doesn't, it sets the URL and emits `did-navigate`. It returns whether the page went.
- `close()` is the user closing the window. It emits `close`, and unless that is prevented, destroys the window, which emits `closed`.
- `loaded` lists the URLs given to `loadURL`, `webContents.windowOpenHandler` is the handler the code set for popups, and `options` is what the constructor got.

`fakeElectron` itself controls the fake:

| Member | Does |
| --- | --- |
| `addWindow({ url, bounds })` | Adds a window that is already open, such as Discord's own. `url` defaults to `https://discord.com/app`. Set `globalThis.mainWindowId` to its `id` to make it Discord's main window. |
| `windows` | Every window, destroyed ones too, oldest first. |
| `fetch` | Answers every session's `fetch` with `(url, init, partition)`. A 404 by default, or the `fetch` option. Set it any time. |
| `sessions` | Each session made, by partition. |
| `opened` | Each URL `shell.openExternal` got. |
| `dialogAnswers`, `dialogCalls` | What each kind of dialog answers next, and each dialog shown. |
| `encryptionAvailable`, `storageBackend` | What `safeStorage` reports. `true` and `"gnome_libsecret"` by default. |
| `reset()` | Destroys every window and empties the sessions, links, and dialog calls, and sets the answers back. Call it between tests. |

The options are `fetch`, `userAgent` (each session's starting user agent, a Discord desktop one with Electron and discord tokens by default), and `paths` (what `app.getPath` answers, by name, `/fake/<name>` by default). Only the members above exist. A native side that uses another part of Electron, such as `net`, needs the test to add it: `mock.module("electron", () => ({ ...electron.module, net: { fetch } }))`.

```ts
test("signs in through the login window", async () => {
	electron.reset();
	const signedIn = native.connect();
	const win = electron.windows.at(-1)!;
	await electron.sessions.get("persist:music-demo-music")!.cookies.set({ url: "https://music.example.com", name: "session", value: "1" });
	win.navigate("https://music.example.com/home");
	expect(await signedIn).toBe(true);
	expect(win.isDestroyed()).toBe(true);
});
```
