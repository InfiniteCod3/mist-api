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
| `restart` | Restarts Discord with `--remote-debugging-port`. |

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `--port <n>` | `9222` | The debugging port. `restart` uses it for the flag it passes. |
| `-n <count>` | `50` | How many records `logs`, `calls`, and `native-logs` print. |
| `--json` | off | Prints raw JSON instead of lines. `values`, `call`, and `eval` always print JSON. |
| `-f`, `--follow` | off | `logs` keeps printing new lines. |
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
weather-demo  running  mist 0.2.0  native: mist (debug open)  errors: 0 calls, 0 logs
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
