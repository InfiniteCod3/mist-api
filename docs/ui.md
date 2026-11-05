# UI

`@aurologic/mist-api/ui` puts a plugin's UI inside Discord's. It has these parts:

- An error boundary, so UI that throws shows a small notice instead of breaking the Discord UI around it.
- Observable state that `useStore`, `subscribe` and the `useValue` hook read.
- A host, a mount point that keeps working across hot reloads.
- Registries for chat bar buttons, message hover bar buttons, UI under messages, and listeners that run before a message is sent or edited.

```ts
import { accessories, Boundary, boundary, ChatBarButton, chatBar, host, messages, popover, state, useValue } from "@aurologic/mist-api/ui";
```

The boundary, the state and the host work without `mist.define`. The registries need source patches, which a plugin adds to its `patches`.

## A plugin with a chat bar button

```tsx
import { createMist } from "@aurologic/mist-api";
import { ChatBarButton, chatBar, messages, state, useValue } from "@aurologic/mist-api/ui";

const mist = createMist("shout");
const on = state(false);

function ShoutButton() {
	const active = useValue(on);
	return (
		<ChatBarButton label={active ? "Stop shouting" : "Shout"} active={active} onClick={() => on.update(v => !v)}>
			<svg width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M3 10v4h4l5 5V5L7 10H3z" /></svg>
		</ChatBarButton>
	);
}

export default mist.define({
	patches: [...chatBar.patches, ...messages.patches],
	start() {
		chatBar.add(mist, "toggle", ShoutButton);
		messages.beforeSend(mist, "upper", draft => {
			if (on.get()) draft.content = draft.content.toUpperCase();
		});
	},
});
```

Call `add` and `beforeSend` in `start`. Each entry is removed when the plugin stops, so `stop` has nothing to undo.

## Owners

Every registry function and `host().set` takes an owner first. The owner is the plugin's `mist`, or Evi's `ctx` for a plugin that doesn't use mist-api's `createMist`. The owner decides three things:

- The entry is removed when the owner's run stops.
- Errors in the entry are logged through the owner's log, `mist.log.error` or `ctx.logger.error`.
- The owner's id sorts the entry. Entries show in `<plugin id>/<entry id>` order, whatever order plugins start in.

Adding UI to a `mist` whose plugin isn't running throws, because `mist.ctx` throws then.

## Boundary

```ts
type Fallback = ReactNode | ((error: unknown, retry: () => void) => ReactNode);

interface BoundaryOptions {
	fallback?: Fallback;
	name?: string;
	mist?: { readonly log: { error(...args: unknown[]): void; }; };
}

function Boundary(props: BoundaryOptions & { children?: ReactNode; }): ReactElement;
function boundary<P extends object>(Component: ComponentType<P>, options?: BoundaryOptions): ComponentType<P>;
```

`Boundary` catches errors while its children render. In their place it shows the fallback:

- Without `fallback`, it shows a one-line notice, "`<name>` couldn't be shown.", with a Retry link.
- With a node, it shows that node. `null` shows nothing.
- With a function, it shows the function's result. The function gets the error and a `retry` that renders the children again.

The first time each distinct error is caught, it is logged with `name`, through `mist.log` when `mist` is given and through `console.error` otherwise. The same error again is not logged, so a component that throws on every render logs once. After 50 distinct errors in one log, the boundary stops logging.

`boundary(Component, options)` wraps a component in a `Boundary`, for a component that you hand to Discord or a patch. `name` defaults to the component's name.

```tsx
export const SafePanel = boundary(Panel, { mist, fallback: null });
```

A boundary catches errors during rendering only, as React's error boundaries do. Errors in event handlers, timers and promises aren't caught.

## state and useValue

```ts
interface Readable<T> extends ChangeSource {
	get(): T;
}
interface State<T> extends Readable<T> {
	set(value: T): void;
	update(fn: (current: T) => T): void;
}

function state<T>(initial: T): State<T>;
function useValue<T>(source: Readable<T>): T;
```

`state(initial)` is one value that a plugin's UI and the rest of its code share. `set` calls the listeners only when the value is a new one, compared with `Object.is`. `update(fn)` sets the result of `fn` applied to the current value.

`useValue(source)` returns the value and renders the component again on each change. A `State` is also a `ChangeSource`, so [`useStore` and `subscribe`](stores.md) take it like a Flux store:

```ts
const unread = state(0);
mist.ctx.onDispose(subscribe(unread, () => mist.log.info("unread", unread.get())));
const label = useStore(unread, () => `${unread.get()} unread`);
```

A `state` lives in one copy of the plugin's code. A hot reload starts with a new one. To keep a value across a hot reload, or to share it between plugins, use a [slot](bus.md#slot).

## host

```ts
interface Host<P> {
	readonly Component: ComponentType<P>;
	set(owner: Owner, Component: ComponentType<P>, options?: { fallback?: Fallback; }): () => void;
}

function host<P extends object = {}>(name: string): Host<P>;
```

Discord keeps the component that a patch handed it. After a hot reload, that component is still the stopped copy's, which reads the stopped copy's state. `host(name)` solves this. `Component` is the same component in every copy of the plugin and every copy of mist-api, so a patch can hand it to Discord once. It renders the component that the running copy passed to `set`, inside a `Boundary`, and it renders nothing while the plugin is stopped.

`set` returns a function that clears the host. Stopping the plugin clears it too. A new start's `set` replaces the old one, and the old run's late cleanup doesn't clear the new component.

```tsx
const sidebar = host<{ channelId: string; }>("weather/sidebar");

export default mist.define({
	patches: [{
		find: "…",
		replace: { match: /…/, with: "$&,$self.Sidebar" },
	}],
	Sidebar: sidebar.Component,
	start() {
		sidebar.set(mist, ({ channelId }) => <Forecast channelId={channelId} />);
	},
});
```

The name is the protocol between copies. Start it with the plugin's id, and change it when the props change.

## Registries

The four registries share one design:

- Each has `patches`. Spread them into the plugin's `patches`. Every plugin that uses a registry carries its patches, and the patched code calls the registry only once, however many plugins carry them. When the plugin that put the call in is turned off, Evi runs the module again with the other plugins' patches, and one of them puts the call in.
- The registry's state is on `globalThis` under a `Symbol.for("mist-api.ui/<name>@1")` key, so plugins that bundle different copies of mist-api share one registry. The first copy's functions serve every copy until Discord reloads.
- Each entry renders inside a `Boundary` named `<plugin id>/<entry id>`. Adding an id that the plugin already used replaces that entry.
- `add` and the message functions return a function that removes the entry. Stopping the plugin removes it too.

The patches are marked [`onDemand`](core.md#ondemand), because Discord loads the chat and message code only when a channel opens. Until then, `mist status` shows them as waiting.

### chatBar

```ts
interface ChatBarProps {
	channel: Channel;
	disabled?: boolean;
	type?: { analyticsName?: string; };
}

chatBar.add(owner: Owner, id: string, Component: ComponentType<ChatBarProps>, options?: { fallback?: Fallback; }): () => void;

function ChatBarButton(props: { label: string; onClick(event: MouseEvent): void; active?: boolean; children: ReactNode; }): ReactElement;
```

Adds a button to the chat bar, after Discord's gift, GIF, sticker, emoji and apps buttons and before the send button. The component gets the props that Discord gives its own buttons. `type.analyticsName` is `"normal"` in a channel's own chat bar. Return `null` to show nothing, for example in a thread or a DM where the button doesn't fit.

`ChatBarButton` looks like Discord's own buttons. Its children are the icon, about 20 by 20 pixels. If Discord renames its button, `ChatBarButton` falls back to a plain button.

A chat bar button that throws shows nothing by default. Pass `fallback` to show something else.

### popover

```ts
interface PopoverProps {
	message: Message;
	channel: Channel;
	Button: ComponentType<{ label: string; icon: ComponentType<{ className?: string; }>; onClick(event: MouseEvent): void; dangerous?: boolean; disabled?: boolean; separator?: boolean; }>;
}

popover.add(owner: Owner, id: string, Component: ComponentType<PopoverProps>, options?: { fallback?: Fallback; }): () => void;
```

Adds a button to the hover bar of every message, before the quick reactions. Render `props.Button`, which is Discord's own hover bar button, with your label, icon and click handler:

```tsx
popover.add(mist, "copy-text", ({ Button, message }) =>
	message.content ? <Button label="Copy text" icon={CopyIcon} onClick={() => copy(message.content)} /> : null);
```

A hover bar button that throws shows nothing by default.

### accessories

```ts
interface AccessoryProps {
	message: Message;
	channel: Channel;
}

accessories.add(owner: Owner, id: string, Component: ComponentType<AccessoryProps>, options?: { fallback?: Fallback; }): () => void;
```

Adds UI under every message, after its embeds, attachments and reactions. The component renders for each message on screen, so return `null` quickly for the messages it isn't for, and keep the work for the others in `useStore` or `useMemo`.

An accessory that throws shows the boundary's notice by default, because UI that disappears without a trace under a message looks like a missing feature.

### messages

```ts
interface SendDraft {
	readonly channel: Channel;
	content: string;
}
interface EditDraft extends SendDraft {
	readonly message: Message;
}
type Verdict = void | { cancel: boolean; };

messages.beforeSend(owner: Owner, id: string, listener: (draft: SendDraft) => Verdict | Promise<Verdict>): () => void;
messages.beforeEdit(owner: Owner, id: string, listener: (draft: EditDraft) => Verdict | Promise<Verdict>): () => void;
```

`beforeSend` runs the listener before each message that the user sends from the chat box. `beforeEdit` runs it before each edit that the user saves. Spread `messages.patches` into the plugin's `patches` for either one.

The listeners run after Discord has checked the message, so they don't run for a message that Discord turns down, such as one sent during slow mode. They run one at a time, in `<plugin id>/<entry id>` order, and the message waits for each one, so a listener can be `async`. A listener changes what is sent or saved by setting `draft.content`. Discord then handles the new content as it does what the user typed.

A listener that returns `{ cancel: true }` stops the message, and the listeners after it don't run. Discord keeps the text in the message box, or the edit open, so the user can change it.

A listener that throws is logged once through its plugin's log, and the message goes on with the content it has at that point. A listener that sets `content` to something other than a string is logged, and the content goes back to what it was before that listener.

With no listeners, the patched code goes on at once, so a plain message isn't delayed.

These listeners see messages typed in the chat box and edits saved in Discord's editor. They don't see messages that other code sends through Discord's API, such as other plugins.

## Shared state and versions

The key of each registry ends in `@1`, the protocol version of its shared state. A copy that finds a key that holds state it can't read throws `mist ui: mist-api.ui/<name>@1 was made by an incompatible copy`. When the shape of the shared state changes, mist-api raises the version, and copies of each version then keep separate registries.
