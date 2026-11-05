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

Every command except `restart` and `manifest fix` connects the same way:

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
| `errors [id] [-f]` | Prints console errors, uncaught exceptions, and the page's error log entries, each with the plugin it came from. |
| `perf` | Prints where each plugin spends time, and the applied patches whose `$self` functions never ran. |
| `dev <id>` | Prints each hot reload of a plugin: whether it started, its start error, and its patch health. |
| `module <id|text> [--diff]` | Prints a webpack module's source as Evi's patches left it, or its diff against Discord's original. |
| `react <selector>` | Prints the React components that render an element, with their props, and marks the ones Evi hooked. |
| `manifest fix [dir]` | Checks a plugin's `manifest.json` for missing translations and Evi's 16 KB limit. With `--write`, fixes it. |
| `leaks <id> --yes` | Turns a dev build off and on, and prints the counts that grew with every cycle. |
| `restart` | Restarts Discord with `--remote-debugging-port`. |

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `--port <n>` | `9222` | The debugging port. `restart` uses it for the flag it passes. |
| `-n <count>` | `50` | How many records `logs`, `calls`, `native-logs`, and `errors` print, and how many actions `flux` prints before it stops. |
| `--json` | off | Prints raw JSON instead of lines. `values`, `call`, `eval`, and a `store` call always print JSON. `flux` prints one JSON object per line. |
| `-f`, `--follow` | off | `logs` keeps printing new lines. `flux` keeps printing actions, and `errors` new errors, until Ctrl+C. |
| `--full` | off | `flux`, `store`, `errors`, and `react` cut values at the bounds of recorded values instead of the shorter display bounds. |
| `--depth <n>` | `4`, `10` | How many ancestors `inspect` prints (4), and how many components `react` prints (10). |
| `--all` | off | `inspect` prints every match, not only the first. `perf` prints every site of each plugin, not the 5 slowest. |
| `--diff` | off | `module` prints the patches' changes instead of the whole source. |
| `--write` | off | `manifest fix` writes its fixes to `manifest.json`. |
| `--cycles <n>` | `3` | How many times `leaks` turns the plugin off and on, from 1 to 50. |
| `--yes` | off | `leaks` runs. Without it, `leaks` only checks that it may. |
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

`native` is `unknown` until the plugin first starts, then `none`, `plain`, or `mist`. [createMist](core.md#the-page-registry) defines each one. `errors` counts failed native calls and `error` log lines among the records still kept. A plugin with `quiet` methods gets a line such as `quiet calls, counted and not kept: poll 312`. A plugin that subscribes to its native side's events counts `__mist_events` there. A plugin whose handle was registered more than once gets a `registry` line. Each concern the registry has about the handle gets a `WARNING` line, such as a registration refused while the handle's plugin ran. [Security model](security.md#replacing-a-handle) lists the concerns. Each warning of the plugin's run gets a `warning` line: a store read in `start` before Discord made it, a migration that threw, a `$self` name the definition has no function for, or a plugin it needs at another protocol version. Warnings don't stop `mist call`. Under `patches` and `lookups`, each problem gets its own indented line.

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

The listener lives in the page, and the CLI reads what it kept every 250 ms. The page keeps the newest 1000 actions between reads, on `globalThis`, where every plugin can read them, message text included, until the CLI reads them or the watch ends. When it drops older ones, `flux` prints `… <n> actions dropped`. When `flux` stops, it removes the listener. If the CLI ends without doing that, for example when it is killed, the page removes the listener 15 seconds after the last read. A page reload removes it too. In both cases a CLI that still runs prints `The page ended the watch`.

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

## errors

```sh
mist errors
mist errors weather-demo -f
```

Prints the page's errors, oldest first, as `<time> <source> [<plugin>] <message>` with up to four stack frames under each. There are three sources:

| Source | What it is |
| --- | --- |
| `console` | A `console.error` or `console.assert` call, including each error that Evi catches and logs instead of throwing. |
| `exception` | An uncaught exception or an unhandled promise rejection. |
| `log` | An error entry of the page's own log, such as a failed network request or a blocked request. |

When it connects, the page replays the errors it kept, so `errors` shows errors from before it ran. It prints the newest `-n` of them. With `-f`, it then prints each new error until you press Ctrl+C.

With an id, `errors` prints only the errors that it attributes to that plugin. It attributes an error in this order:

1. A line from Evi's logger: the plugin whose name the logger has, as with `mist.log.error`. For Evi's own loggers, the plugin that Evi's message names: `after hook of <id> on …`, `Failed to start <name>`, or `Module <n> threw. It was patched by: <ids>`. Such a line starts with the logger's name, as in `[Hooks]`.
2. A stack frame in a plugin's code, which Evi evaluates as `evi://plugins/<id>.js`.
3. A stack frame in a module that Evi patched, `evi://modules/<n>.js`: every plugin with a patch on that module. To find them, `errors` reads `Evi.diagnosePatches()` once.

Evi's watch build, `bun scripts/build.ts --watch`, adds an inline source map to each plugin. For such a plugin, `errors` prints each of its frames at the place in your source file, as in `at boom (src/index.ts:3:11)`. Other builds have no map, and their frames show as `evi://plugins/<id>.js:<line>:<column>`. After a hot reload, the old build and the new one have the same URL. A frame that CDP reports names the script it ran in, so `errors` maps it through that build's map. A frame read from an error's stack text names only the URL, so `errors` maps it only when one build has that URL, and otherwise prints it unmapped.

To read the maps, `errors` turns on CDP's debugger. It tells the debugger to skip every pause before it turns it on, so a breakpoint or a `debugger;` statement never stops Discord's page. If the debugger doesn't accept that, `errors` stops with an error and turns nothing on. A pause that comes anyway, as when another debugging client turns skipping off, is resumed at once. `module` turns on the debugger the same way.

Object arguments are copied with the masking of recorded values and cut to the display bounds, as a `flux` payload is. An error's message and stack are text, so they aren't masked by name. Instead, every URL in the printed text and in the frames loses its query string and fragment, and a webhook URL's token, the segment after `/webhooks/<id>/`, shows as `[secret]`.

## perf

```sh
mist perf
mist perf --all
```

Prints `Evi.perf.snapshot()`: for each plugin that ran code, the time it took since Discord started and in the last 10 seconds, and its 5 slowest sites. A site is a hook, a Flux handler, a `$self` function that patched code called, a timer, or `start()`. With `--all`, each site is printed. The first line is `Evi.stats`, the time that Evi added to the loading of Discord's modules.

Then `perf` lists each applied patch whose string replacements name `$self` functions none of which has run. Such a patch changed its module, but Discord hasn't run the changed code. Often the code is on a screen that isn't open yet. If it stays on the list once you use the feature, the replacement is in code that never runs. A function replacement can't be read, so `perf` only counts those.

`perf` reads `Evi.diagnosePatches()`, which compares each patch with every module and can block Discord for half a second. It never starts a recording, which would restart one that Evi's Performance tab is making.

## dev

```sh
mist dev weather-demo
```

Watches the plugin through `Evi.plugins.subscribe` until Ctrl+C. Each time Evi hot-reloads it, `dev` waits until the plugin is quiet for a second, because an async `start` ends after the reload, and then prints one line with the new version and how the reload ended: `running`, `start error: <error>`, or `not running`. Under the line, it prints the plugin's patch health. When a changed patch can't apply until Discord reloads, it prints `needs a Discord reload (Ctrl+R)` and the reason:

```text
14:02:11.482 reloaded 1.2.1, running
  patches: 2 applied
14:03:40.007 changed, start error: SyntaxError: Unexpected token '}'
```

A `changed` line is a change without a new manifest, such as new code that doesn't evaluate. A change of Discord's language gives every plugin a new manifest, so it doesn't count as a reload. Evi hot-reloads dev builds, the plugins that its watch build writes, and `dev` says so when the plugin is installed another way.

The listener lives in the page. The page removes it 15 seconds after the CLI last read it, as for `flux`.

## module

```sh
mist module 123456
mist module 123456 --diff
mist module '"premium-feature-tier"'
```

Prints a webpack module's source as it ran. Give the module's id, or text that only one module's source contains. When several modules contain the text, `module` lists their ids.

When Evi patched the module, it compiled a copy with the source URL `evi://modules/<id>.js`, and `module` reads that copy through CDP's debugger, with every pause skipped as for [errors](#errors). Otherwise it prints Discord's original, and says whether the module is loaded yet. The first line names the patches whose records list the module.

With `--diff`, `module` prints each change against the original, with 40 characters around it:

```text
@@ at 256791  weather-demo
  …er:e,status:a,isMobile:s,subText:
- (
+ Evi.$("weather-demo")?.subText?.((
  0,v.jsx)(E7,{hovered:t,activities:i…
```

Each change names the plugins it is likely from: the plugins whose `$self` the added code calls, and the patches whose `match` matches where the change is. The diff and the matches run on Discord's original as Evi patches it, where a method shorthand factory such as `123(e,t,n){` starts with `function(e,t,n){`. When neither says, it names every patch on the module, after `maybe`. Changes closer than 32 characters are shown as one. The diff gives up on a copy that differs in more than 4000 tokens.

## react

```sh
mist react '[class^="nameTag_"]'
mist react 'nav ul' --depth 4
```

Finds the first element that matches the CSS selector and prints the element, then each React component above it, nearest first, up to `--depth` components (10 by default). Each line is a component's name and its kind (`class`, `memo`, `forwardRef`, or `context`; a function component shows no kind), with its props on the next line. Discord's code is minified, so many names are one or two letters.

Props are copied with the masking of recorded values, two levels deep, and `--full` uses the larger bounds. `children` shows as a count. When the props have `type: "password"`, or an `autoComplete` that mentions `password` or `one-time-code`, their `value` and `defaultValue` show as `[secret]`.

`hooked by Evi` marks a component whose function Evi wrapped for a plugin's hook. Evi keeps no record of whose hook it is, so `react` names the plugins with a measured hook site named after the component, after `maybe`, and names none for a one- or two-letter name.

## manifest fix

```sh
mist manifest fix
mist manifest fix plugins/weather-demo --write
```

Reads `manifest.json` in the folder, or in the current folder, and checks it against two rules of Evi's store. It doesn't connect to Discord.

- Translations. Every language Evi ships besides English (`de`, `es`, `fr`, `ja`, `pl`, `pt-BR`, `ru`, `tr`) needs `name`, `description` when the English one isn't empty, and notes for the current version in `locales.<language>`, as Evi's upload check asks. An empty list of notes counts as missing, and an entry for the current version in the English `changelog` asks for notes even when its own list is empty. `manifest fix` lists each one that is missing. With `--write`, it adds each as a copy of the English text. Translate them before you upload. The check of the code's `defineStrings` tables isn't part of this command: `bun run preview-plugin` in Evi runs it.
- Size. Evi's plugin CLI refuses to upload a built `manifest.json` over 16 KB (16384 bytes). `manifest fix` measures the manifest as Evi's build writes it, with `main` and, when there is a `native.ts`, `native` added. When it is over, `manifest fix` drops the other languages' notes for the oldest versions, oldest first, until it fits. Versions are ordered as semver, so a prerelease such as `1.1.0-beta.2` is older than `1.1.0`. English notes stay, and a language without notes for a version shows the English ones. The current version's notes are never dropped. If the manifest would still be over with every old translated note gone, `manifest fix` drops nothing, writes nothing, even with `--write`, and says by how many bytes it is over.

Without `--write`, it changes nothing and says what it would do. `--write` writes `manifest.json` with four-space indentation.

## leaks

```sh
mist leaks weather-demo --yes
mist leaks weather-demo --cycles 5 --yes
```

Turns the plugin off and on `--cycles` times, 3 by default, through `Evi.plugins.setEnabled`. It counts these after it starts, after each stop, and after each start, 1.5 seconds after each switch:

| Count | What it counts |
| --- | --- |
| `nodes` | Elements in the document. |
| `styles` | `<style>` and stylesheet `<link>` elements, and adopted stylesheets. |
| `subscribers` | Flux handlers subscribed with `Dispatcher.subscribe`. |
| `interceptors` | Flux interceptors. |
| `listeners` | Event listeners on the page, from CDP's `Performance.getMetrics`. |

It prints each count against the first, and `LEAK?` for each count that rose after every stop and after every start. Discord changes the page on its own, so one cycle's rise doesn't count, and a busy channel can raise `nodes` without a leak.

`leaks` changes the plugin's switch in Evi's settings and runs its `stop` and `start`, so it runs only on a dev build that is running, and only with `--yes`. Without `--yes`, it checks the plugin and says what it would do.

`leaks` refuses a plugin with a native side or Chromium switches. Each time such a plugin is turned on, Evi asks you in a dialog, so `leaks` couldn't turn it on again by itself.

`leaks` leaves the plugin on, also when a cycle fails or turning it off fails. Ctrl+C stops it at the next step, after it turns the plugin on again. A second Ctrl+C doesn't exit before that. If turning the plugin on again fails, `leaks` says so: turn it on in Evi's settings.

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
