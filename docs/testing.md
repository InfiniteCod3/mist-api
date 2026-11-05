# Testing

`@aurologic/mist-api/testing` has test doubles for a plugin's unit tests: a fake plugin context, a fake Flux store, a fake Flux dispatcher, and a fake `@evi/api` module. They work with any test runner. The module imports no runner and nothing at runtime from `@evi/api`, so it loads in Bun, Vitest, Jest, or plain Node.

```ts
import { fakeContext, fakeDispatcher, fakeEvi, fakeStore } from "@aurologic/mist-api/testing";
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
| `Dispatcher` | A `fakeDispatcher()`. |
| `React` | The `React` passed to `fakeEvi`. Reading it throws when none was passed. |

`evi` itself controls the fake:

| Member | Does |
| --- | --- |
| `addStore(name, store)` | Adds a store, and calls back each waiting `waitFor` whose filter takes it. This is how a test makes a store arrive late, as Discord makes many stores after a plugin starts. |
| `removeStore(name)` | Removes a store. |
| `ready` | While `false`, `findStore` and `getStore` throw. `true` by default. |
| `lookups` | Each name `findStore` and `getStore` were asked for, oldest first. |

Only the members above exist. Code that uses another export of `@evi/api`, such as `showToast` or `filters.byProps`, needs the test to add it to the module object:

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
