# Changelog

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
