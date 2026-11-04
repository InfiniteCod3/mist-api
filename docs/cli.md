# CLI

`mist` debugs Evi plugins built on mist-api, over Discord's debugging port. Its source is `bin/mist.ts`, the package's `bin` is the built `dist/bin/mist.js`, and it is never bundled into a plugin.

## Run it

It runs on Node 22 or later. From npm, run it with `npx -p @aurologic/mist-api mist`, which works whether or not it's installed. Name the package with `-p`: a bare `npx mist` outside the install folder downloads an unrelated npm package called `mist`.

```sh
npx -p @aurologic/mist-api mist <command> [options]
```

From a mist-api checkout, run the built file, or run the source with Node 22.18 or later or with Bun:

```sh
node dist/bin/mist.js <command> [options]
node bin/mist.ts <command> [options]
bun bin/mist.ts <command> [options]
```

Node strips TypeScript types only for files outside `node_modules`, so the source can't run with `node` from an installed package. The built file is plain JavaScript and runs from anywhere.

`mist`, `mist help`, `mist --help`, and `mist -h` print the usage. On an error, `mist` prints the message and exits with code 1.

## Connect

Every command except `restart` connects the same way:

1. It reads `http://127.0.0.1:<port>/json/list` and gives up after 5 seconds.
2. It keeps the targets that are pages on `discord.com` or a subdomain, with `/app` and `/channels` pages first.
3. It opens each page's websocket in turn and uses the first one where `typeof Evi === "object"`.

Each CDP request times out after 20 seconds.

If nothing answers, the error is `Nothing answers on 127.0.0.1:9222. Start Discord with --remote-debugging-port=9222 (mist restart).`

## Commands

| Command | Does |
| --- | --- |
| `status` | Lists every mist plugin with its state, errors, and patch and lookup health. |
| `logs <id> [-f]` | Prints the plugin's page log. With `-f`, keeps printing new lines. |
| `calls <id>` | Prints its native calls with arguments, result or error, and time taken. |
| `native-logs <id>` | Prints what its native side logged and was called with. |
| `values <id>` | Prints the values it exposes, and its settings. |
| `call <id> <method> [args]` | Calls a native method. Each arg is JSON, or a plain string. |
| `patches [id]` | Prints Evi's patch and lookup diagnosis, problems first. |
| `eval <expression>` | Evaluates an expression in Discord's page and prints the result. |
| `flux [types...] [-f]` | Prints Flux actions as Discord dispatches them: the named types, or every action. |
| `store <Store> [method] [args]` | Lists a Flux store's methods, or calls one that reads and prints the result. |
| `inspect <selector>` | Prints an element's layout and its ancestors', with the CSS rules that set it. |
| `restart` | Restarts Discord with `--remote-debugging-port`. |

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `--port <n>` | `9222` | The debugging port. `restart` uses it for the flag it passes. |
| `-n <count>` | `50` | How many records `logs`, `calls`, and `native-logs` print, and how many actions `flux` prints before it stops. |
| `--json` | off | Prints raw JSON instead of lines. `values`, `call`, `eval`, and a `store` call always print JSON. `flux` prints one JSON object per line. |
| `-f`, `--follow` | off | `logs` keeps printing new lines. `flux` keeps printing actions until Ctrl+C. |
| `--full` | off | `flux` and `store` cut values at the bounds of recorded values instead of the shorter display bounds. |
| `--depth <n>` | `4` | How many ancestors `inspect` prints. |
| `--all` | off | `inspect` prints every match, not only the first. |
| `--dry-run` | off | `restart` prints what it would run. |

## What the CLI sees

`logs`, `calls`, `native-logs`, `values`, and `call` go through the plugin's debug capability, which the CLI reads from the private field of the plugin's handle with `Runtime.getProperties`. If the handle has no private field, or more than one, the command fails and asks for a rebuild of the plugin.

`logs`, `calls`, and `values` show the page's records whole for every plugin, with or without a native side. `native-logs` and `call` are gated. They work fully only when the plugin's native side is made with `defineNative` and reports that Discord's main process has `--remote-debugging-port` or `--remote-debugging-pipe`. [Security model](security.md) explains why the page's records need no gate and the native side does.

Fields named like secrets are masked everywhere.

## status

```sh
mist status
```

Reads `window.Mist.status()`. Each plugin gets one line, followed by its start error from Evi, if any, and its patch and lookup health:

```text
weather-demo  running  mist 0.2.1  native: mist (debug open)  errors: 0 calls, 0 logs
  registry: registered 2 times, 1 replacing another handle (a hot reload replaces one)
  patches: 2 applied
  lookups: none
```

`native` is `unknown` until the plugin first starts, then `none`, `plain`, or `mist`. [createMist](core.md#the-page-registry) defines each one. `errors` counts failed native calls and `error` log lines among the records still kept. A plugin with `quiet` methods gets a line such as `quiet calls, counted and not kept: poll 312`. A plugin that subscribes to its native side's events counts `__mist_events` there. A plugin whose handle was registered more than once gets a `registry` line. Each concern the registry has about the handle gets a `WARNING` line, such as a registration refused while the handle's plugin ran. [Security model](security.md#replacing-a-handle) lists the concerns. Under `patches` and `lookups`, each problem gets its own indented line.

If no mist-api plugin has loaded, `status` fails with `No mist-api plugin has loaded on this page`.

## logs

```sh
mist logs weather-demo
mist logs weather-demo -f -n 200
```

Prints the plugin's page log, oldest first, one line per record as `<time> <level> <args>`. With `-f`, it reads the newest `-n` records every second and prints the ones it hasn't printed yet. It runs until you stop it with Ctrl+C.

## calls

```sh
mist calls weather-demo
```

Prints the page side's record of native calls, as in:

```text
14:02:11.482 lookup({"latitude":52.52,"longitude":13.41}) ok 212 ms -> {"temperature":11.8}
14:02:15.007 lookup({"latitude":"x","longitude":"y"}) FAILED 9 ms: Bad place
```

A call that hasn't settled shows `… pending`. A call of a `quiet` method shows only if it failed. `mist status` counts the others. Argument lists and results longer than 300 characters are cut.

## native-logs

```sh
mist native-logs weather-demo
```

Asks the plugin's native side for its ring through the hidden `__mist_logs` method, and prints its calls and then its log lines, with the native side's quiet call counts between them. Native `console` output goes to main's stdout, which CDP can't see, so this command is the way to read it.

It fails with `<id> has no native side made with defineNative, or isn't running` when there is nothing to ask. When main has no debugging port, it warns that values are shown as type and size only. The native side reduced those values when it recorded them, so a restart with the port shows only the values recorded after it.

## values

```sh
mist values weather-demo
```

Prints `{ "values": ..., "settings": ... }` as JSON. `values` holds each value from `mist.expose`, read when the command runs. `settings` is the plugin's settings, or `null` while it isn't running.

## call

```sh
mist call weather-demo lookup '{"latitude":52.52,"longitude":13.41}'
mist call weather-demo add 1 2
```

Calls a native method through the capability and prints the result as JSON. The call is recorded like any other, so it shows in `mist calls`.

Each argument after the method name is parsed as JSON. If it isn't valid JSON, it is passed as the plain string. So `2` is a number and `true` is a boolean. To pass the string `"true"`, quote it as JSON, as in `'"true"'`.

Before it sends any argument, `call` reads the registry's concerns about the plugin's handle. It sends nothing, and fails with `mist call sends nothing to <id>` and the list of concerns, when there is a concern or when the handle says the plugin isn't running. A registry that keeps no history can't be checked. Then `call` prints a warning and calls anyway.

`call` refuses unless the capability is open, with one of these errors:

| Error | Cause |
| --- | --- |
| `<id> isn't running` | The plugin is stopped. |
| `<id> has no native module` | The plugin has no `native.ts`. |
| `<id>'s native module doesn't use defineNative, so mist can't tell whether main has a debugging port` | The native module doesn't answer `__mist_debugAllowed`. |
| `Discord's main process wasn't started with --remote-debugging-port` | Main's argv has no debugging port or pipe. |

## patches

```sh
mist patches
mist patches weather-demo
```

Prints `Evi.diagnosePatches()` and `Evi.diagnoseLookups()`, for one plugin or for all. Each list is sorted with problems first (`broken`, `failed`, `partial`, `ambiguous`, `missing`), then `waiting`, then the rest. It works for every Evi plugin, not only for mist plugins.

## eval

```sh
mist eval "Evi.plugins.get('weather-demo')"
```

Evaluates the expression in Discord's page, awaits a promise result, and prints the result as JSON. The arguments after `eval` are joined with spaces.

## flux

```sh
mist flux PRESENCE_UPDATES TYPING_START
mist flux -n 20
mist flux MESSAGE_CREATE -f
```

Prints each Flux action that Discord dispatches, one line per action as `<time> <type> <payload>`. The payload is the action without its `type`, as JSON. With types, `flux` subscribes to each one with `Dispatcher.subscribe`. Without types, it watches every action through an interceptor on Discord's dispatcher. The interceptor returns `false`, so Discord still handles each action.

Without `-f`, `flux` stops after `-n` actions, 50 by default. With `-f`, it prints until you press Ctrl+C. A second Ctrl+C exits at once. Discord dispatches many actions each second, so watching every action with `-f` prints a lot.

The listener lives in the page, and the CLI reads what it kept every 250 ms. The page keeps the newest 1000 actions between reads. When it drops older ones, `flux` prints `… <n> actions dropped`. When `flux` stops, it removes the listener. If the CLI ends without doing that, for example when it is killed, the page removes the listener 15 seconds after the last read. A page reload removes it too. In both cases a CLI that still runs prints `The page ended the watch`.

Each payload is copied when the action is dispatched, with the masking that recorded values get: fields and `Map` keys named like secrets show as `"[secret]"`. Some actions, such as `CONNECTION_OPEN`, carry tokens and session ids, and those fields are masked. A bare string has no name, so it is never masked. Values are cut to the display bounds:

| Bound | Display | `--full` |
| --- | --- | --- |
| String length | 200 | 2000 |
| Array, `Set`, and `Map` items | 10 | 50 |
| Object keys | 20 | 50 |
| Depth | 4 | 6 |
| Objects copied per value | 300 | 20000 |

A cut string ends in `…(+<n> chars)`, a cut list in `"…(+<n> items)"`, and a cut object in a `"…"` key. A value past the depth shows as `"[too deep]"`. An object past the copy limit shows as `"…"`.

If Discord's dispatcher has no interceptor list, `flux` without types fails and asks for action types.

## store

```sh
mist store SelectedChannelStore
mist store SelectedChannelStore getChannelId
mist store ChannelStore getChannel '"1234567890123456789"'
```

With only a store name, `store` lists the store's methods, read from its class and the classes it extends, without the methods every Flux store has. The methods that `store` can call are under `reads`, and the others under `not called by mist`. When the store has a `getState` method, the keys of its state are listed too:

```text
SelectedChannelStore
  reads: getChannelId getCurrentlySelectedChannelId getLastChannelFollowingDestination getLastSelectedChannelId getLastSelectedChannels getMostRecentSelectedTextChannelId getVoiceChannelId
  not called by mist: initialize
```

With a method, `store` calls it and prints the result as JSON, masked and cut like a `flux` payload. `--full` uses the larger bounds. Each argument after the method name is parsed as JSON, or passed as the plain string when it isn't valid JSON, as in [call](#call). A Discord id is longer than a JavaScript number holds exactly, so pass it as a JSON string.

`store` calls only methods named as reads: names that start with `get`, `is`, `has`, `find`, `can`, `should`, `are`, or `supports`, followed by a capital letter or nothing. It refuses names that go on with `Or` or `And`, such as `getOrCreatePendingEdit` and `getAndDeleteMostRecentUserCreatedThreadId`, which Discord's stores have and which change state. A refused method is never sent to the page. A name is not a guarantee: a Discord getter can still start a request or fill a cache the first time it runs.

A store's values need no gate, because a CDP client can read the whole page anyway. [Security model](security.md#what-a-cdp-client-can-read-anyway) explains this. Masking still applies with `--full`.

`store` fails with `No Flux store is named <name>` when `findStore` finds no store of that name, and with `<store> has no method <method>` when the store has no such method.

## inspect

```sh
mist inspect '[class^="sidebar_"]'
mist inspect 'nav[aria-label] > ul' --depth 2 --all
```

Prints the first element that matches the CSS selector, then each ancestor up to `--depth`. With `--all`, it prints each match. For each element, it prints:

- The tag, id, and classes, the size, and the position in the viewport.
- The computed layout values that differ from the initial value: `display`, `position`, `flex`, `flex-direction`, `flex-wrap`, `justify-content`, `align-items`, `align-self`, `gap`, `margin`, `padding`, `overflow`, `white-space`, `text-overflow`, `min-width`, `max-width`, `min-height`, `max-height`, `grid-template-columns`, `order`, `transform`, and the `top`, `right`, `bottom`, and `left` offsets. `display` is always printed.
- The number of children, and the first five.
- The `style` attribute, if any.
- Each CSS rule in `document.styleSheets` that matches the element and sets a layout property, with its layout declarations and the file or `<style>` it comes from.

```text
element  span.item  96x18 at 8,8
  display: block; flex: 1 1 0px; overflow: hidden; white-space: nowrap
  children: 0
  span (1 of 3 selectors) { margin: 0px; padding: 0px }  <style>
  .row > .item { flex: 1 1 0px; white-space: nowrap }  app.css
```

Rules are listed in stylesheet order, so of two rules with the same specificity, the later one wins. A rule inside `@media` is listed only when its media query matches, and is prefixed with the query. A rule inside `@supports`, `@layer`, or `@container` is prefixed with its condition, which `inspect` doesn't check. For a selector list, only the selectors in it that match are printed, with how many the list has. Nested CSS rules aren't listed. A stylesheet from another origin can't be read, and `inspect` says how many it skipped.

## restart

```sh
mist restart
mist restart --port 9333 --dry-run
```

On Windows, `restart` runs `taskkill /IM Discord.exe /F`, which closes Discord without letting it save. After 1.5 seconds, it starts Discord through `%LOCALAPPDATA%\Discord\Update.exe --processStart Discord.exe --process-start-args --remote-debugging-port=<port>`. It fails if `Update.exe` isn't there. With `--dry-run`, it prints both commands and runs neither.

On macOS and Linux, `restart` runs nothing. It prints the command to run instead:

```sh
# macOS
osascript -e 'quit app "Discord"'; open -a Discord --args --remote-debugging-port=9222
# Linux
pkill -x Discord; discord --remote-debugging-port=9222 &
```

Anyone who can reach the debugging port controls Discord, including your account. It listens on `127.0.0.1`. Restart Discord normally when you are done debugging.
