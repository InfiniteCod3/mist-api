# CLI

`mist` debugs Evi plugins built on mist-api, over Discord's debugging port. Its source is `bin/mist.ts`. The package's `bin` is the built `dist/bin/mist.js`, which is never bundled into a plugin.

## Run it

It runs on Node 22 or later. From npm, run it with `npx -p @aurologic/mist-api mist`, which works whether or not the package is installed. Name the package with `-p`: a bare `npx mist` outside the install folder downloads an unrelated npm package called `mist`.

```sh
npx -p @aurologic/mist-api mist <command> [options]
```

From a mist-api checkout, run the built file, or run the source with Node 22.18 or later or with Bun:

```sh
node dist/bin/mist.js <command> [options]
node bin/mist.ts <command> [options]
bun bin/mist.ts <command> [options]
```

Node strips TypeScript types only for files outside `node_modules`. The source therefore can't run with `node` from an installed package. The built file is plain JavaScript and runs from anywhere.

`mist`, `mist help`, `mist --help`, and `mist -h` print the usage. `--help` or `-h` after a command does the same. `mist --version` and `mist -v` print the installed version.

## Arguments and errors

`mist` refuses an option it doesn't know instead of reading it as an argument:

```text
Unknown option --x. Run "mist help" for options, or use "--" before positional arguments.
```

Everything after `--` is an argument: `mist eval -- -1` and `mist call my-plugin note -- --draft` pass `-1` and `--draft` as they are. A negative number such as `-1`, or a bare `-`, is an argument even without `--`.

`mist` checks its arguments before it connects to Discord. A command without its required argument fails at once with the command's usage, as in `mist logs needs a plugin id (mist status lists them)`. Numeric options are checked the same way: `--port` takes a whole number from 1 to 65535, `-n` a whole number from 1, `--depth` 0 or more, `--cycles` 1 to 50, and `--timeout` a number of seconds above 0.

On an error the CLI expects, such as a refused option, nothing on the port, or a plugin that isn't running, `mist` prints the message alone and exits with code 1. Any other error is a bug in `mist`: it prints the whole error with its stack and exits with code 1.

With `--json`, every error prints to stdout as `{"error": "<message>"}`, where the command's JSON would have gone, and `mist` still exits with code 1. A script reads one stream either way.

## Connect

Every command except `restart` and `manifest` connects the same way. `restart --wait` connects this way after the restart:

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
| `store <name> [method] [args]` | Lists a Flux store's methods, or calls a reading one and prints the result. |
| `inspect <selector>` | Prints an element's layout and its ancestors', with the CSS rules that set it. |
| `errors [id] [-f]` | Prints console errors, uncaught exceptions, and the page's error log entries, each with the plugin it came from. |
| `perf` | Prints where each plugin spends time, and the applied patches whose `$self` functions never ran. |
| `dev <id>` | Prints each hot reload of a plugin: whether it started, its start error, and its patch health. |
| `module <id\|text> [--diff]` | Prints a webpack module's source as Evi's patches left it, or its diff against Discord's original. |
| `react <selector>` | Prints the React components that render an element, with their props, and marks the ones Evi hooked. |
| `manifest fix [dir]` | Checks a plugin's `manifest.json` for missing translations and Evi's 16 KB limit. With `--write`, fixes it. |
| `manifest bump [dir] <version>` | Sets the next version and adds its changelog entry in every language. With `--write`, writes it. |
| `leaks <id> --yes` | Turns a dev build off and on, and prints the counts that grew with every cycle. |
| `restart [--wait <id>]` | Restarts Discord with `--remote-debugging-port`. With `--wait`, waits until a plugin runs. |

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `--port <n>` | `9222` | The debugging port, from 1 to 65535. `restart` uses it for the flag it passes. |
| `-n <count>` | `50` | How many records `logs`, `calls`, `native-logs`, and `errors` print, and how many actions `flux` prints before it stops. |
| `--json` | off | Prints raw JSON instead of lines, and errors as `{"error": "..."}` on stdout. `values`, `call`, `eval`, and a `store` call always print JSON. `flux` prints one JSON object per line. |
| `-f`, `--follow` | off | `logs` keeps printing new lines. `flux` keeps printing actions, and `errors` new errors, until Ctrl+C. |
| `--full` | off | `flux`, `store`, `errors`, and `react` cut values at the bounds of recorded values instead of the shorter display bounds. |
| `--depth <n>` | `4`, `10` | How many ancestors `inspect` prints (4), and how many components `react` prints (10). |
| `--all` | off | `inspect` prints every match, not only the first. `perf` prints every site of each plugin, not the 5 slowest. |
| `--diff` | off | `module` prints the patches' changes instead of the whole source. |
| `--write` | off | `manifest fix` and `manifest bump` write `manifest.json`. |
| `--note <text>` | none | An English note for the version `manifest bump` adds. Repeat it for more notes. |
| `--note-<lang> <text>` | a copy of the English | That language's note for the version `manifest bump` adds, as in `--note-de`. Repeat it for more notes. |
| `--wait <id>` | none | `restart` waits until that plugin's page side runs. |
| `--timeout <s>` | `60` | How many seconds `restart --wait` waits. |
| `--cycles <n>` | `3` | How many times `leaks` turns the plugin off and on, from 1 to 50. |
| `--yes` | off | `leaks` runs. Without it, `leaks` only checks that it may. |
| `--dry-run` | off | `restart` prints what it would run. |
| `-v`, `--version` | off | Prints mist's version and exits. |
| `--` | none | Ends the options. Every word after it is an argument, even one that starts with `-`. |

## What the CLI sees

`logs`, `calls`, `native-logs`, `values`, and `call` go through the plugin's debug capability. The CLI reads it from the private field of the plugin's handle with `Runtime.getProperties`. If the handle has no private field, or more than one, the command fails and asks for a rebuild of the plugin.

`logs`, `calls`, and `values` show the page's records whole for every plugin, with or without a native side. `native-logs` and `call` are gated: they work fully only when the plugin's native side is made with `defineNative` and reports that Discord's main process has `--remote-debugging-port` or `--remote-debugging-pipe`. [Security model](security.md) explains why the page's records need no gate and the native side does.

Fields named like secrets are masked everywhere.

## status

```sh
mist status
```

Reads `window.Mist.status()`. Each plugin gets one line, followed by its start error from Evi, if any, and its patch and lookup health:

```text
weather-demo  running  mist 0.5.0  native: mist (debug open)  errors: 0 calls, 0 logs
  registry: registered 2 times, 1 replacing another handle (a hot reload replaces one)
  patches: 2 applied
  lookups: none
```

`native` is `unknown` until the plugin first starts, then `none`, `plain`, or `mist`, as [createMist](core.md#the-page-registry) defines. `errors` counts failed native calls and `error` log lines among the records still kept.

Further lines appear when they apply:

- `quiet calls, counted and not kept: poll 312` for a plugin with `quiet` methods. A plugin that subscribes to its native side's events counts `__mist_events` here.
- `registry:` for a handle registered more than once.
- `concern:` for each doubt the registry has about the handle, such as a registration refused while the handle's plugin ran. [Security model](security.md#replacing-a-handle) lists them. A concern makes `mist call` send nothing.
- `warning:` for each problem of the plugin's run: a store read in `start` before Discord made it, a migration that threw, a `$self` name the definition has no function for, or a needed plugin at another protocol version. Warnings don't stop `mist call`.
- One indented line under `patches` and `lookups` for each problem.

If no mist-api plugin has loaded, `status` fails with `No mist-api plugin has loaded on this page`.

## logs

```sh
mist logs weather-demo
mist logs weather-demo -f -n 200
```

Prints the plugin's page log, oldest first, one line per record as `<time> <level> <args>`.

With `-f`, it reads the newest `-n` records every second and prints the ones it hasn't printed yet, until Ctrl+C. When more than `-n` lines came between two reads, it says so on stderr instead of skipping them silently:

```text
… more than 50 lines came between two reads and some aren't shown (-n reads more)
```

Two identical lines in the same millisecond print as two.

## calls

```sh
mist calls weather-demo
```

Prints the page side's record of native calls:

```text
14:02:11.482 forecast({"latitude":52.52,"longitude":13.41}) ok 212 ms -> {"temperature":11.8}
14:02:15.007 forecast({"latitude":"x","longitude":"y"}) failed 9 ms: Bad place
```

A call that hasn't settled shows `… pending`. A call of a `quiet` method shows only if it failed; `mist status` counts the others. Argument lists and results longer than 300 characters are cut.

## native-logs

```sh
mist native-logs weather-demo
```

Asks the plugin's native side for its ring through the hidden `__mist_logs` method. It prints the calls, then the native side's quiet call counts, then the log lines. Native `console` output goes to main's stdout, which CDP can't see. This command is the way to read it.

It fails with `<id> has no native side made with defineNative, or isn't running` when there is nothing to ask. When main has no debugging port, it warns that values are shown as type and size only. The native side reduced those values as it recorded them. After a restart with the port, only values recorded since then show whole.

## values

```sh
mist values weather-demo
```

Prints `{ "values": ..., "settings": ... }` as JSON. `values` holds each value from `mist.expose`, read when the command runs. `settings` is the plugin's settings, or `null` while it isn't running.

## call

```sh
mist call weather-demo forecast '{"latitude":52.52,"longitude":13.41}'
mist call weather-demo add 1 2
```

Calls a native method through the capability and prints the result as JSON. The call is recorded like any other and shows in `mist calls`.

Each argument after the method name is parsed as JSON. One that isn't valid JSON is passed as the plain string: `2` is a number and `true` is a boolean. To pass the string `"true"`, quote it as JSON, as in `'"true"'`.

Before it sends any argument, `call` reads the registry's concerns about the plugin's handle. When there is a concern, or the handle says the plugin isn't running, it sends nothing and fails with `mist call sends nothing to <id>` and the list of concerns. A registry that keeps no history can't be checked: `call` prints a warning and calls anyway.

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

Prints `Evi.diagnosePatches()` and `Evi.diagnoseLookups()`, for one plugin or for all. Each list puts problems first (`broken`, `failed`, `partial`, `ambiguous`, `missing`), then `waiting`, then the rest. It works for every Evi plugin, not only mist plugins.

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

Prints each Flux action that Discord dispatches, one line per action as `<time> <type> <payload>`. The payload is the action without its `type`, as JSON. With types, `flux` subscribes to each one with `Dispatcher.subscribe`. Without types, it watches every action through an interceptor on Discord's dispatcher. The interceptor returns `false`, and Discord still handles each action.

Without `-f`, `flux` stops after `-n` actions, 50 by default. With `-f`, it prints until Ctrl+C; a second Ctrl+C exits at once. Discord dispatches many actions each second, and watching every action with `-f` prints a lot.

The listener lives in the page, and the CLI reads what it kept every 250 ms. Between reads, the page keeps the newest 1000 actions on `globalThis`. Every plugin can read them there, message text included, until the CLI reads them or the watch ends. When the page drops older ones, `flux` prints `… <n> actions dropped`.

When `flux` stops, it removes the listener. A CLI that ends without doing that, such as one that is killed, leaves it for 15 seconds after its last read, and then the page removes it. A page reload removes it too. In both cases a CLI that still runs prints `The page ended the watch`.

Each payload is copied when the action is dispatched, with the masking that recorded values get: fields and `Map` keys named like secrets show as `"[secret]"`. Some actions, such as `CONNECTION_OPEN`, carry tokens and session ids, and those fields are masked. A bare string has no name and is never masked. Values are cut to the display bounds:

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

With only a store name, `store` lists the store's methods, read from its class and the classes it extends, without the methods every Flux store has. The methods `store` can call are under `reads`, the others under `not called by mist`. A store with a `getState` method also lists the keys of its state:

```text
SelectedChannelStore
  reads: getChannelId getCurrentlySelectedChannelId getLastChannelFollowingDestination getLastSelectedChannelId getLastSelectedChannels getMostRecentSelectedTextChannelId getVoiceChannelId
  not called by mist: initialize
```

With a method, `store` calls it and prints the result as JSON, masked and cut like a `flux` payload. `--full` uses the larger bounds. Arguments after the method name are parsed as in [call](#call). A Discord id is longer than a JavaScript number holds exactly: pass it as a JSON string.

`store` calls only methods named as reads: names that start with `get`, `is`, `has`, `find`, `can`, `should`, `are`, or `supports`, followed by a capital letter or nothing. It refuses names that go on with `Or` or `And`, such as `getOrCreatePendingEdit` and `getAndDeleteMostRecentUserCreatedThreadId`, which change state. A refused method is never sent to the page. A name is not a guarantee: a Discord getter can still start a request or fill a cache the first time it runs.

A store's values need no gate, because a CDP client can read the whole page anyway, as [Security model](security.md#what-a-cdp-client-can-read-anyway) explains. Masking still applies with `--full`.

`store` fails with `No Flux store is named <name>` when `findStore` finds no store of that name, and with `<name> has no method <method>` when the store lacks the method.

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

Rules are listed in stylesheet order: of two rules with the same specificity, the later one wins. A rule inside `@media` is listed only when its media query matches, prefixed with the query. A rule inside `@supports`, `@layer`, or `@container` is prefixed with its condition, which `inspect` doesn't check. For a selector list, only the selectors that match are printed, with how many the list has. Nested CSS rules aren't listed. A stylesheet from another origin can't be read, and `inspect` says how many it skipped.

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
| `log` | An error entry of the page's log, such as a failed or blocked network request. |

When it connects, the page replays the errors it kept, so `errors` also shows errors from before it ran. It prints the newest `-n` of them. With `-f`, it then prints each new error until Ctrl+C.

With an id, `errors` prints only the errors it attributes to that plugin. It attributes an error in this order:

1. A line from Evi's logger: the plugin whose name the logger has, as with `mist.log.error`. For Evi's built-in loggers, the plugin that Evi's message names: `after hook of <id> on …`, `Failed to start <name>`, or `Module <n> threw. It was patched by: <ids>`. Such a line starts with the logger's name, as in `[Hooks]`.
2. A stack frame in a plugin's code, which Evi evaluates as `evi://plugins/<id>.js`.
3. A stack frame in a module that Evi patched, `evi://modules/<n>.js`: every plugin with a patch on that module. To find them, `errors` reads `Evi.diagnosePatches()` once.

Evi's watch build, `bun scripts/build.ts --watch`, adds an inline source map to each plugin. For such a plugin, `errors` prints each frame at its place in your source, as in `at boom (src/index.ts:3:11)`. Other builds have no map, and their frames show as `evi://plugins/<id>.js:<line>:<column>`.

After a hot reload, the old build and the new one share a URL. A frame that CDP reports names the script it ran in, and `errors` maps it through that build's map. A frame read from an error's stack text names only the URL. `errors` maps it only when one build has that URL and otherwise prints it unmapped.

To read the maps, `errors` turns on CDP's debugger. It first tells the debugger to skip every pause, which keeps a breakpoint or a `debugger;` statement from stopping Discord's page. If the debugger doesn't accept that, `errors` stops with an error and turns nothing on. A pause that comes anyway, as when another debugging client turns skipping off, is resumed at once. `module` turns on the debugger the same way.

Object arguments are copied with the masking of recorded values and cut to the display bounds, like a `flux` payload. An error's message and stack are text and can't be masked by name. Instead, every URL in the printed text and the frames loses its query string and fragment, and a webhook URL's token, the segment after `/webhooks/<id>/`, shows as `[secret]`.

## perf

```sh
mist perf
mist perf --all
```

Prints `Evi.perf.snapshot()`: for each plugin that ran code, the time it took since Discord started and in the last 10 seconds, and its 5 slowest sites. A site is a hook, a Flux handler, a `$self` function that patched code called, a timer, or `start()`. With `--all`, each site is printed. The first line is `Evi.stats`, the time that Evi added to the loading of Discord's modules.

`perf` then lists each applied patch whose string replacements name `$self` functions, none of which has run. Such a patch changed its module, but Discord hasn't run the changed code yet. Often the code is on a screen that isn't open. If the patch stays on the list after you use the feature, the replacement is in code that never runs. A function replacement can't be read, and `perf` only counts those.

`perf` reads `Evi.diagnosePatches()`, which compares each patch with every module and can block Discord for half a second. It never starts a recording, which would restart one that Evi's Performance tab is making.

## dev

```sh
mist dev weather-demo
```

Watches the plugin through `Evi.plugins.subscribe` until Ctrl+C. Each time Evi hot-reloads it, `dev` waits until the plugin is quiet for a second, because an async `start` ends after the reload. It then prints one line with the new version and how the reload ended: `running`, `start error: <error>`, or `not running`. Under the line, it prints the plugin's patch health. When a changed patch can't apply until Discord reloads, it prints `needs a Discord reload (Ctrl+R)` and the reason:

```text
14:02:11.482 reloaded 1.2.1, running
  patches: 2 applied
14:03:40.007 changed, start error: SyntaxError: Unexpected token '}'
```

A `changed` line is a change without a new manifest, such as new code that doesn't evaluate. A change of Discord's language gives every plugin a new manifest and doesn't count as a reload. Evi hot-reloads only dev builds, the plugins its watch build writes, and `dev` says so when the plugin is installed another way.

The listener lives in the page. The page removes it 15 seconds after the CLI last read it, as for `flux`.

## module

```sh
mist module 123456
mist module 123456 --diff
mist module '"premium-feature-tier"'
```

Prints a webpack module's source as it ran. Give the module's id, or text that only one module's source contains. When several modules contain the text, `module` lists their ids.

For a module Evi patched, Evi compiled a copy with the source URL `evi://modules/<id>.js`. `module` reads that copy through CDP's debugger, with every pause skipped as for [errors](#errors). Otherwise it prints Discord's original and says whether the module is loaded yet. The first line names the patches whose records list the module.

With `--diff`, `module` prints each change against the original, with 40 characters around it:

```text
@@ at 256791  weather-demo
  …er:e,status:a,isMobile:s,subText:
- (
+ Evi.$("weather-demo")?.subText?.((
  0,v.jsx)(E7,{hovered:t,activities:i…
```

Each change names the plugins it likely comes from: the plugins whose `$self` the added code calls, and the patches whose `match` matches where the change is. The diff and the matches run on Discord's original as Evi patches it, where a method shorthand factory such as `123(e,t,n){` starts with `function(e,t,n){`. When neither says, it names every patch on the module, after `maybe`. Changes closer than 32 characters are shown as one. The diff gives up on a copy that differs in more than 4000 tokens.

## react

```sh
mist react '[class^="nameTag_"]'
mist react 'nav ul' --depth 4
```

Finds the first element that matches the CSS selector and prints it, then each React component above it, nearest first, up to `--depth` components (10 by default). Each line is a component's name and its kind (`class`, `memo`, `forwardRef`, or `context`; a function component shows no kind), with its props on the next line. Discord's code is minified, and many names are one or two letters.

Props are copied with the masking of recorded values, two levels deep, and `--full` uses the larger bounds. `children` shows as a count. When the props have `type: "password"`, or an `autoComplete` that mentions `password` or `one-time-code`, their `value` and `defaultValue` show as `[secret]`.

`hooked by Evi` marks a component whose function Evi wrapped for a plugin's hook. Evi keeps no record of whose hook it is. `react` names the plugins with a measured hook site named after the component, after `maybe`, and names none for a one- or two-letter name.

An element that React doesn't render prints `React doesn't render this element: it has no fiber`. With `--json`, `react` prints `{ matches, components, problem? }`, where `problem` holds that reason when there are no components to show. Before 0.5 the field was named `error`.

## manifest fix

```sh
mist manifest fix
mist manifest fix plugins/weather-demo --write
```

Reads `manifest.json` in the given folder, or in the current one, and checks it against two rules of Evi's store. It doesn't connect to Discord.

- **Translations.** Every language Evi ships besides English (`de`, `es`, `fr`, `ja`, `pl`, `pt-BR`, `ru`, `tr`) needs `name`, `description` when the English one isn't empty, and notes for the current version in `locales.<language>`, as Evi's upload check asks. An empty list of notes counts as missing. An entry for the current version in the English `changelog` asks for notes even when its list is empty. `manifest fix` lists each gap, and `--write` fills each one with a copy of the English text. Translate them before you upload. A manifest without a `name` has no English name to copy, and `manifest fix` says to add one. The check of the code's `defineStrings` tables isn't part of this command: `bun run preview-plugin` in Evi runs it.
- **Size.** Evi's plugin CLI refuses to upload a built `manifest.json` over 16 KB (16384 bytes). `manifest fix` measures the manifest as Evi's build writes it, with `main` and, when there is a `native.ts`, `native` added. When it is over, `manifest fix` drops the other languages' notes for the oldest versions, oldest first, until it fits. Versions are ordered as semver: a prerelease such as `1.1.0-beta.2` is older than `1.1.0`. English notes stay, and a language without notes for a version shows the English ones. The current version's notes are never dropped. If the manifest would still be over with every old translated note gone, `manifest fix` drops and writes nothing, even with `--write`, and says by how many bytes it is over.

Without `--write`, it changes nothing and says what it would do. `--write` keeps the file's line endings (CRLF or LF), its indentation, its key order, and its final newline or the lack of one.

## manifest bump

```sh
mist manifest bump patch --note "Fixed the forecast for places without a region."
mist manifest bump plugins/weather-demo 1.4.0 --note "Hourly forecasts." --note-de "Stündliche Vorhersagen." --write
```

Sets the version in `manifest.json`, in the given folder or the current one, and adds that version's entry at the top of the `changelog`. It doesn't connect to Discord.

- The version is `patch`, `minor`, or `major`, which counts up from the current version and drops a prerelease tag, or a semver such as `1.4.0` or `2.0.0-beta.1`.
- It must be higher than the current version, and the `changelog` must not have an entry for it yet.
- `--note` gives the English notes and is required.
- Each language Evi ships besides English gets the notes from its `--note-<lang>`, or a copy of the English notes, put first in `locales.<language>.changelog`. A language outside Evi's list is refused.

Then `manifest bump` does what `manifest fix --write` does: it fills each missing name and description with the English text and drops old translated notes until the built manifest fits in 16 KB. It prints the old and the new version, the languages that got a copy of the English notes, and the built size. When even dropping every old translated note leaves it over 16 KB, it writes nothing and says by how much.

Without `--write`, it changes nothing and says what it would do. `--write` keeps the file's line endings, indentation, and key order, as `manifest fix` does.

## leaks

```sh
mist leaks weather-demo --yes
mist leaks weather-demo --cycles 5 --yes
```

Turns the plugin off and on `--cycles` times, 3 by default, through `Evi.plugins.setEnabled`. It takes these counts after it starts, after each stop, and after each start, 1.5 seconds after each switch:

| Count | What it counts |
| --- | --- |
| `nodes` | Elements in the document. |
| `styles` | `<style>` and stylesheet `<link>` elements, and adopted stylesheets. |
| `subscribers` | Flux handlers subscribed with `Dispatcher.subscribe`. |
| `interceptors` | Flux interceptors. |
| `listeners` | Event listeners on the page, from CDP's `Performance.getMetrics`. |

It prints each count against the first, and `LEAK?` for each count that rose after every stop and after every start. Discord changes the page by itself: one cycle's rise doesn't count, and a busy channel can raise `nodes` without a leak.

`leaks` changes the plugin's switch in Evi's settings and runs its `stop` and `start`. It therefore runs only on a dev build that is running, and only with `--yes`. Without `--yes`, it checks the plugin and says what it would do.

`leaks` refuses a plugin with a native side or Chromium switches. Evi asks for confirmation in a dialog each time such a plugin is turned on, and `leaks` couldn't turn it on again by itself.

`leaks` leaves the plugin on, also when a cycle fails or turning it off fails. Ctrl+C stops it at the next step, after it turns the plugin on again, and a second Ctrl+C doesn't exit before that. If turning the plugin on again fails, `leaks` says so: turn it on in Evi's settings.

## restart

```sh
mist restart
mist restart --port 9333 --dry-run
mist restart --wait weather-demo --timeout 90
```

On Windows, `restart` runs `taskkill /IM Discord.exe /F`, which closes Discord without letting it save. After 1.5 seconds, it starts Discord through `%LOCALAPPDATA%\Discord\Update.exe --processStart Discord.exe --process-start-args --remote-debugging-port=<port>`. It fails when `LOCALAPPDATA` isn't set or `Update.exe` isn't there. With `--dry-run`, it prints both commands and runs neither.

With `--wait <id>`, `restart` then reads `Mist.status()` once a second, as `mist status` does, until that plugin reports `running` or `--timeout` seconds pass (60 by default). While Discord starts, nothing answers on the port, which counts as not running yet. It prints one line, as in `weather-demo is running, 8.2 s after the restart`. On a timeout, the line says what it saw last, such as `weather-demo is stopped` or a start error, and `mist` exits with code 1. `--dry-run` doesn't wait.

On macOS and Linux, `restart` runs nothing and prints the command to run instead. With `--wait`, it then waits while you run it:

```sh
# macOS
osascript -e 'quit app "Discord"'; open -a Discord --args --remote-debugging-port=9222
# Linux
pkill -x Discord; discord --remote-debugging-port=9222 &
```

Anyone who can reach the debugging port controls Discord, including your account. It listens on `127.0.0.1`. Restart Discord normally when you are done debugging.
