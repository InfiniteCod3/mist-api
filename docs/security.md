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

## Native calls from the page

Evi passes each native call with data from Discord's page, and the page is shared with Discord's code and every other plugin. A plugin's native side treats what comes from its page side as untrusted. mist-api's native features follow that rule:

- The call protocol isn't a security boundary. The call mark only tells `defineNative` to answer with an envelope and which call `__mist_abort` names. A page that sends a forged mark, or none, gets the same methods run with the same arguments. `__mist_abort` names a call by a random id that the page side made for it, and aborting only aborts that call's `this.signal`. Errors that cross to the page carry the `name`, `message`, `code`, `data`, and `status` that the native code gave them, and no stack. The page records them for `mist calls`, so a native error shouldn't hold a secret.
- A request's answer is page input. `nativeRequests` checks only that an answer has the envelope's shape and belongs to a request still waiting, and it accepts one answer per request. What the answer holds is whatever the page sent, so native code checks it before acting on it. [nativeRequests](native.md#nativerequests) says so where it's used.
- Path grants keep page input from naming paths. `pathGrants` gives the page an opaque handle for a path the user picked in a dialog that main shows. Only native code turns a handle into a path, and a folder's handle reaches only paths inside that folder. Code that reaches the plugin's page side can use the handles that the page side has, but it can't make one for a path nobody picked. `resolveGrant` checks path text and doesn't resolve links.
- Secrets stay in main. `secrets` encrypts with `safeStorage` into the plugin's own folder. That protects a copied file, not a running Discord: every native module can call `safeStorage` and read the file. `encrypted` is `false` when Electron falls back to Chromium's built-in key on Linux. A native method that returns a secret to the page hands it to every plugin there.

## Permissions through mist

Evi holds a plugin to the `permissions` in its manifest only where Evi can see which plugin is asking: the plugin's own `fetch`, its context, and its copy of `@evi/api`. Requests through Discord's own API client and listeners in mist's UI patches go around that, so mist holds them to the same declaration, by the rules of Evi's guard (`src/renderer/plugins/guard.ts`):

- `discord(mist)` holds `rest` and `messages` to `network` and the message and settings flags, as [Discord](discord.md#permissions) describes.
- `popover.add`, `accessories.add`, `messages.beforeSend`, and `messages.beforeEdit` hand the plugin each message's content, and the last two let it rewrite or cancel what the user sends or saves. Each needs `readMessages`, as Evi's guard asks of a hook on sending and editing. They throw a `PluginPermissionError` before anything is registered.
- A plugin whose manifest declares no `permissions` isn't held to anything, as in Evi. An id that Evi has no loaded plugin by throws an `UnknownPluginError`, so a made-up id doesn't count as a plugin that declares nothing.

To know which plugin asks, these functions take the plugin's own mist object and nothing else. They check it at runtime: the handle that the page registry holds for the object's id must answer `owns(object)` with `true`. Only the handle that `createMist` made answers so, for the one object it made. A string id, or an object that only carries another plugin's `id`, throws a `TypeError`, so a plugin can't name another plugin and borrow its permissions. The UI registries don't take Evi's `ctx`, because nothing on the page can tell one plugin's context from another's: `Evi.plugins` never shows a context.

This is the same kind of check as Evi's guard. It isn't a sandbox:

- Page code shares one JavaScript realm with Discord and every plugin. Code that ignores mist can read the registries' state on `globalThis` under their `Symbol.for("mist-api.ui/…")` keys, add a listener to them directly, or patch Discord's send function itself.
- A stopped plugin's handle can be replaced, as [What page code can still do](#what-page-code-can-still-do) describes, and a plugin that doesn't use `mist.define` has no handle. A stand-in handle whose `owns` says yes passes the owner check for that id.

What these checks catch is what an honest plugin forgot to declare. Evi's store review reads the code and compares the declaration with what it does.

## What this doesn't protect

The design keeps other plugins away from a plugin's capability and native side. It doesn't make the page a trusted place. These limits follow from the code:

- Page log text reaches the console. The handle reduces log strings, but `mist.log` also prints them through `ctx.logger` to the page's console, where any plugin that wraps `console` could read them. Keep secrets out of log strings.
- The bus has no access control. Any plugin can read, set, and publish on any channel or slot.
- A plugin that loads first can install a lying registry. The registry key is a `Symbol.for` key on `globalThis`, and the first copy to set it wins. A malicious plugin that sets it first, or that defines `window.Mist` first, can misreport the other plugins' handles to the CLI. It can't use that to reach another plugin's capability or native side, because each handle is made by the plugin's own copy and the capability is still only in that plugin's closure and its handle's private field.
- A stopped plugin's handle can be replaced, as [What page code can still do](#what-page-code-can-still-do) describes.
- Native modules share main. Every plugin's native side runs in Discord's main process with full access, so another plugin's native code can reach this plugin's native module and call any of its hidden `__mist_` methods itself, answer its requests, or read its `plugin-data` folder, its grants, and its secrets.
- `mist flux` keeps the actions it watches on `globalThis`, under `Symbol.for("mist-cli.flux")`, until the CLI reads them, at most 250 ms later, or the watch ends. While it runs, any plugin can read them there, including the text of messages in `MESSAGE_CREATE` actions. Only the fields named like secrets are masked.
- Anyone with the debugging port has everything. The port gives full control of Discord, including the account's token. That is why the gate opens on it, and why Discord should run without it when you aren't debugging.

## The debug report

`mist.report` builds the [debug report](core.md#mistreport) from the plugin's handle, the same view that every plugin on the page can read. Every recorded value shows as its type and size, so a user can paste the report into a public issue without a secret in it. The text it shows whole is mist-api's own warnings, Evi's start error, and Evi's patch errors, which `Mist.status()` already shows to every plugin. A start error is the message of whatever the plugin's `start` threw, so don't put a secret in an error message.

The report doesn't reach the debug capability, so it never contains the open view, even with a debugging port.

## Version skew

Each plugin bundles its own copy of mist-api, and copies of different versions share one registry. The registry only calls a handle's own methods, so it never needs to understand the records of a copy at another version. `MIST_VERSION` on each handle tells the CLI which copy made it. The registry key ends in `.v1`. A change that a registry from another copy couldn't handle would use a new key.

A plugin's page side and native side can also be different versions, as while an author updates one of them. The page asks the native side's `__mist_protocol` before it sends a call mark, so an older or plain native side never sees one, and an older page never sends one. [How a call crosses IPC](native.md#how-a-call-crosses-ipc) lists each pairing.
