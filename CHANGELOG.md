# Changelog

## Unreleased

- Debug reports for users who can't run the CLI: `mist.report()` returns a report with the plugin, mist-api, Evi and Discord versions, the plugin's status, and its recent page and native logs and calls. Every recorded value shows as its type and size only. `mist.copyReport()` copies it and toasts the result, for a button in `settingsPanel`, and `mist.reportCommand()` is a slash command for `ctx.command` that copies it, or shows it when copying fails.
- A `stores` getter that reads a missing store during the synchronous part of a plugin's `start` is a warning: `mist.log.warn` prints it once, naming the store and `subscribe(["StoreName"], …)` or `useStore("StoreName", …)` as the fix, and `HandleState.warnings` lists it for the run. Evi starts plugins before Discord makes many stores, so such a read gets `undefined` and code built on it does nothing.
- `createMist` takes `provides`, the bus protocols a plugin offers with their versions, and `needs`, the protocols it speaks with other plugins. The handle advertises `provides`. A needed plugin that is installed and turned on, but provides another version or says nothing (copies of 0.2.1 and earlier), is a warning in `HandleState.warnings`, a log line, and one toast that tells the user which plugin to update.
- Settings migrations: `mist.define({ migrate: [{ to, run }] })` runs each step whose `to` is above the stored settings version, in order, before `start`, and stores the version with the plugin's settings under `__mist_settingsVersion` (`SETTINGS_VERSION`). Evi keeps stored values of keys a schema no longer declares, so a step can read a renamed setting's old value. A step that throws is logged and listed in `HandleState.warnings`, and the plugin still starts; it runs again at the next start.
- `HandleState` has `provides` and `warnings`. Warnings aren't registry concerns, so they don't stop `mist call`.

## 0.2.1

- `subscribe` and `useStore` in `@aurologic/mist-api/stores` take a Flux store's name, such as `"PresenceStore"`. A store Discord hasn't made yet is listened to once it has, and the listener is called then. Evi starts plugins before Discord makes many of its stores, so `subscribe([stores.presence], redraw)` in `start` could listen to nothing after a cold start; `subscribe(["PresenceStore"], redraw)` can't. The docs' own example showed the first form and now shows the second.

## 0.2.0

The first release of mist-api, a TypeScript library for Evi plugins.

- `@aurologic/mist-api`: `createMist(id)` is the page side of a plugin. It holds the plugin's context (`mist.ctx`, `mist.running`), types native calls from the plugin's `native.ts` (`mist.native`), and logs through `mist.log`. `mist.expose` publishes values for the CLI, and `mist.safe` wraps a patch callback so it never throws. `onDemand(patch)` marks a source patch whose code Discord downloads later, so the CLI shows it as waiting rather than broken. `MIST_VERSION` is the version of the copy.
- `@aurologic/mist-api/native`: `defineNative(methods)` is the main-process side. It records calls and logs for the CLI, and `debugAllowed()` says whether Discord's main process has a debugging port.
- Events from the native side to the page: `nativeEvents()` makes an ordered, capped event log, and `mist.events.subscribe` reads it, typed from the native module. A page that connects or reconnects runs `onConnect` and gets only the events that `replay` accepts from before. A restart of the native side is detected by a boot id. `stop` answers every waiting poll. See `docs/events.md`.
- `@aurologic/mist-api/stores`: typed Discord Flux stores (`stores`), `currentUserId`, `isStreamerMode`, `subscribe`, and the React hook `useStore`.
- `@aurologic/mist-api/util`: `isRecord`, `sleep`, `fetchWithTimeout`, `fetchJson`, `HttpError`, and the types of Discord's `DiscordNative` bridge.
- `@aurologic/mist-api/bus`: versioned channels and slots that plugins use to talk to each other, shared on `globalThis`.
- The `mist` CLI reads each plugin's logs, native calls, native logs, and exposed values over the Chrome DevTools Protocol. It can also call native methods, list patches, evaluate code, and restart Discord with a debugging port. Run it with `npx -p @aurologic/mist-api mist`.
- Recorded values mask fields named like secrets (`token`, `password`, `cookie`, and similar), plus the names a plugin gives in `secrets` and the arguments it names in `secretArgs`. `reveal` shows a name that a built-in name would mask, and `quiet` counts a method's calls without keeping them.
- Calling native methods, and reading the native side's records whole, work only when Discord's main process was started with a debugging port.
- The page registry keeps a running plugin's handle in place: page code can't replace it. A handle replaced while its plugin was stopped is taken back at the plugin's next start. `mist status` shows each registry concern, and `mist call` sends no arguments to a handle with one. `docs/security.md` has the security model and what page code can still do.
- Copies of different versions, bundled into different plugins, share one debug registry and one bus through versioned `Symbol.for` keys.
