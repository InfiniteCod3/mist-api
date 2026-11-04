# Security model

This page explains how mist-api lets the `mist` CLI see a plugin's values and call its native methods without letting other plugins do the same. The code is in `src/debug.ts`, `src/registry.ts`, and `src/native.ts`. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## The threat

Every Evi plugin runs in the same Discord page. Any plugin can read and change anything on `window`, wrap any global function, and read anything another plugin leaves there. A plugin with a native side can run any code in Discord's main process, with full file and network access.

Evi keeps those two facts apart. It never puts a plugin's context on `window`. `window.Evi.plugins` (`PublicPlugins` in Evi's `src/renderer/plugins/manager.ts`) shows each plugin's public state, but never its context, its native bridge, its settings, or its definition. If one plugin could reach another's `ctx.native.call`, a plugin that the user installed as page-only could use another plugin's native powers. For example, it could make it read files or send requests that its own manifest never asked for.

A debugger needs exactly what Evi hides. It needs to call native methods and to read arguments, results, and settings. A `call()` reachable from `window` would reopen the hole for every plugin on the page, every time the debugging port is on.

## Two views of each plugin

mist-api splits each plugin's debug state into two objects.

The handle goes into the page-wide registry behind `window.Mist`. Every plugin can reach it. It shows each value only as its type and size, as in `"object(2 keys)"` or `"string(40)"`. Log text and the messages of failed calls are reduced the same way. Its `call()` always rejects. It still tells the CLI that the plugin exists, whether it runs, and how many errors it has.

The capability shows the page's records whole: logs, calls, exposed values, and settings, with secret fields masked. Its `call()` and its native records are gated, as [The gate](#the-gate) explains. Only the plugin's own closure and its handle's private field hold a reference to it. Page code can reach neither.

The CLI reaches the capability through CDP. The handle is an instance of a class with one private field, `#capability`, that holds the plugin's capability. The CLI reads the handle from the registry and asks `Runtime.getProperties` for its private fields. CDP lists them, and the handle's single private field is the capability. If the handle has no private field, or more than one, the CLI refuses and says so.

Page JavaScript can't do this. A private field can only be read by code inside its class, and that class is in the plugin's own copy of mist-api. Page code can't add the real capability to an object of its own either, because it never has a reference to it. `Runtime.getProperties` is a CDP method, and page code has no CDP. Page code also can't open a CDP connection to the debugging port, because Chromium refuses websocket connections to the port whose origin is a web page.

## What a CDP client can read anyway

Only a CDP client reaches the capability, and a CDP client can already read the whole page. `Runtime.getProperties` lists a function's closure scopes, and `HeapProfiler` takes a snapshot of every object on the page. The page side records every value whole in the plugin's closure, so a CDP client could read those records without the capability. Reducing them in the capability would hide nothing from anyone who can reach it.

Without a debugging port, a CDP client is still possible in two ways. One is the DevTools window that the person at the computer opens. The other is main-process code that attaches `webContents.debugger`, which needs a native side, and a native side already has full access. Neither is page code. So the capability shows the page's records whole whatever the plugin's native side is, and with or without the port.

## The gate

Two things are not on the page, so reading the page doesn't give them away. One is `call()`, which runs native code in Discord's main process. The other is the native side's own record, which lives in main. The gate covers those two. It opens only when Discord's main process was started with `--remote-debugging-port` or `--remote-debugging-pipe`. Anyone who can use that port already controls the whole app, so opening them to that person gives away nothing.

The page can't see main's argv. The plugin's own native side reads it. When the plugin starts, `mist.define` calls the native module's hidden `__mist_debugAllowed` method. A module made with `defineNative` answers `debugAllowed()`, which tests `process.argv` in main. The page can't change that argv.

The answer is kept in the plugin's closure for the life of that copy of mist-api, because main's argv can't change while Discord runs. It is never written to `window`, so another plugin can't flip it. A rejected call isn't an answer, because a module without the hidden method and a failed IPC call look the same. The plugin counts as `"plain"` until the next debug request asks again.

The answer depends on the plugin's native side:

| Native side | `HandleState.native` | Gate |
| --- | --- | --- |
| None | `"none"` | Closed. `call()` refuses with `has no native module`. There is no native record. |
| Not made with `defineNative` | `"plain"` | Closed. `call()` refuses, because mist can't tell whether main has a port. There is no native record. |
| `defineNative`, main without a port | `"mist"` | Closed. `call()` refuses with `wasn't started with --remote-debugging-port`. The native record is reduced. |
| `defineNative`, main with a port | `"mist"` | Open. `call()` works and the native record is whole. |

In every row the capability shows the page's own records whole. `MistCapability.open()` and `HandleState.debug` report the gate. A plugin without a mist native side can never be called through the CLI, even with the port on.

The native side also guards its own record. Its ring keeps values whole only when main has a port. Without one, it reduces each argument, result, log argument, and error message to its type and size as it records it, so the whole value is never kept in memory to leak later.

## Masking

Fields and `Map` keys whose names look like secrets are masked as `"[secret]"` in both views, including the capability. The built-in names match `token`, `secret`, `passw`, `cookie`, `authorization`, `api_key`, `credential`, and `session`. A plugin adds its own field and key names with the `secrets` option of `createMist` and of `defineNative`. Each is a whole name, matched without regard to case. The aim is `mist calls` output that you can paste into an issue, as long as no secret sits in a bare string or a log string.

Masking goes by name. A bare string, such as a positional argument or an array item, has no name, so it can't be recognized as a secret and shows whole in the capability. Pass secrets inside an object field or under a `Map` key with a secret name.

## Replacing a handle

The CLI trusts the registry: the handle it finds there for an id is where it reads the capability from. Page code can reach `register` through the registry key, so `register` decides when a handle may take an id from another one. It can't ask the new handle for proof, because a plugin's new copy after a hot reload is a new bundle and shares no secret with its old copy. It uses the order Evi gives instead. Evi stops a plugin's run, and disposes its context, before it evaluates the plugin's new code. So when a genuine new copy registers, the old handle's plugin is never running.

- **A running plugin keeps its id.** While the id's handle says its plugin runs, `register` refuses another handle for the id and counts the refusal. It still returns an unregister function, which does nothing.
- **A stopped plugin's id can change hands.** When the handle says its plugin isn't running, the new handle takes its place, and the registry counts a replacement.
- **A plugin takes its id back.** Each time the plugin starts, it checks that its own handle holds the id, and registers it again if not. The registry counts a handle that comes back after another took its place as reclaimed. If the handle holding the id says it runs, the plugin's registration is refused, and the plugin logs `Another handle holds <id> in the debug registry and says it is running`.

The registry keeps this history per id: `registered`, `replaced`, `refused`, and `reclaimed`. Page code can read it but can't change it. From it, the registry lists concerns about the id's handle:

- A registration was refused, so two handles claim the id.
- The handle was replaced while the plugin was stopped, and the plugin took it back.
- The handle says the plugin runs, but `Evi.plugins.get(id)` says it is stopped.

`mist status` shows the history and each concern as a `WARNING` line. Before `mist call` sends any argument, the CLI reads the concerns from the registry key, not from `window.Mist`. It sends nothing when there is a concern, or when the handle says the plugin isn't running, since the plugin's own capability refuses a call then. `window.Mist` can't be redefined once mist-api has defined it.

### What page code can still do

Hostile page code can do these things. Each follows from the code above:

- **Put in a stand-in while the plugin is stopped.** A plugin is stopped before its first start, between runs, and while it is turned off. Evi evaluates a plugin's code at startup before it starts it, so every plugin has such a window at startup. A stand-in put in then gets the plugin's `mist logs`, `mist calls`, `mist values`, and `mist native-logs` until the plugin's next start, and shows false records there. In the history, its replacement looks the same as a hot reload. At the plugin's next start the plugin takes the id back, and the reclaim shows as a concern.
- **Take `mist call` arguments in one case.** A stand-in put in while the plugin is stopped, which says the plugin runs, gets the arguments of `mist call` until the plugin's next start, when page code also wraps `Evi.plugins.get` to say that the plugin runs. `window.Evi` can't be redefined, but `Evi.plugins` can be. Without the wrap, Evi's answer is a concern and the CLI sends nothing. The stand-in still can't reach the plugin's capability or its native side, so it can't make the call happen.
- **Hold an id.** A stand-in that says it runs keeps the id against the plugin's own registrations. The plugin's refused registration is a concern, so `mist status` warns and `mist call` sends nothing. The plugin can't be debugged until Discord restarts without the hostile code.
- **Block `mist call` for any plugin.** A registration that is refused is still counted, so page code can make any plugin's handle have a concern. This denies debugging. It reveals nothing.
- **Take the registry or `window.Mist` first.** Code that runs before every copy of mist-api can set the registry key or define `window.Mist` itself, and then misreport every plugin. The next section covers this.
- **Use a registry without history.** A registry from a copy of mist-api that has no `history` or `concerns` method replaces handles without checks. For such a registry, `mist call` prints that it can't check the handle, and calls anyway.

Closing the stopped-plugin window needs a key per plugin that only that plugin gets, which page code never sees. Evi's plugin API has no such key today.

## What this doesn't protect

The design keeps other plugins away from a plugin's capability and native side. It doesn't make the page a trusted place. These limits follow from the code:

- Page log text reaches the console. The handle reduces log strings, but `mist.log` also prints them through `ctx.logger` to the page's console, where any plugin that wraps `console` could read them. Keep secrets out of log strings.
- The bus has no access control. Any plugin can read, set, and publish on any channel or slot.
- A plugin that loads first can install a lying registry. The registry key is a `Symbol.for` key on `globalThis`, and the first copy to set it wins. A malicious plugin that sets it first, or that defines `window.Mist` first, can misreport the other plugins' handles to the CLI. It can't use that to reach another plugin's capability or native side, because each handle is made by the plugin's own copy and the capability is still only in that plugin's closure and its handle's private field.
- A stopped plugin's handle can be replaced, as [What page code can still do](#what-page-code-can-still-do) describes.
- Native modules share main. Every plugin's native side runs in Discord's main process with full access, so another plugin's native code can reach this plugin's native module and call `__mist_logs` or `__mist_events` itself.
- Anyone with the debugging port has everything. The port gives full control of Discord, including the account's token. That is why the gate opens on it, and why Discord should run without it when you aren't debugging.

## Version skew

Each plugin bundles its own copy of mist-api, and copies of different versions share one registry. The registry only calls a handle's own methods, so it never needs to understand the records of a copy at another version. `MIST_VERSION` on each handle tells the CLI which copy made it. The registry key ends in `.v1`. A change that a registry from another copy couldn't handle would use a new key.
