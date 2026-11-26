# UI

`@aurologic/mist-api/ui` puts a plugin's UI inside Discord's. It has these parts:

- An error boundary: UI that throws shows a small notice instead of breaking the Discord UI around it.
- Observable state that `useStore`, `subscribe`, and the `useValue` hook read.
- A host, a mount point that keeps working across hot reloads.
- Registries for chat bar buttons, message hover bar buttons, UI under messages, and listeners that run before a message is sent or edited.
- Settings-panel pieces that look like Discord's: a button, a switch, a text input, a tooltip, a card, a row, and a callout.

```ts
import { accessories, Boundary, boundary, Button, Callout, Card, ChatBarButton, chatBar, host, messages, popover, Row, state, Switch, TextInput, Tip, useValue } from "@aurologic/mist-api/ui";
```

The boundary, the state, the host, and the settings pieces work without `mist.define`. The registries need the plugin's `mist`, from `createMist`, and source patches, which a plugin adds to its `patches`.

## A plugin with a chat bar button

```tsx
import { createMist } from "@aurologic/mist-api";
import { ChatBarButton, chatBar, messages, state } from "@aurologic/mist-api/ui";

const mist = createMist("shout");
const on = state(false);

function ShoutButton() {
	const active = on.use();
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

Call `add` and `beforeSend` in `start`. Each entry is removed when the plugin stops, and `stop` has nothing to undo.

## Owners

Every registry function and `host().set` takes an owner first. The owner decides three things:

- The entry is removed when the owner's run stops.
- Errors in the entry are logged through the owner's log, `mist.log.error` or `ctx.logger.error`.
- The owner's id sorts the entry. Entries show in `<plugin id>/<entry id>` order, whatever order plugins start in.

The registries (`chatBar`, `popover`, `accessories`, and `messages`) take only the plugin's `mist` object. A string id, Evi's `ctx`, or a look-alike object throws a `TypeError`, as [Which plugin is asking](security.md#which-plugin-is-asking) explains. `host().set` also takes Evi's `ctx`, for a plugin that doesn't use `createMist`, because a host hands the plugin nothing.

Adding UI to a `mist` whose plugin isn't running throws, as `mist.ctx` does then.

## Permissions

`popover.add`, `accessories.add`, `messages.beforeSend`, and `messages.beforeEdit` hand the plugin the content of messages, and the message hooks can also rewrite or cancel what the user sends. Each needs the plugin's manifest to declare `readMessages`, or to declare no `permissions` at all. That is the rule Evi's guard applies to a plugin that hooks Discord's sending and editing:

```json
"permissions": { "readMessages": true }
```

Without it, the call throws a `PluginPermissionError`, as in `example can't read messages (popover.add): its manifest doesn't declare permissions.readMessages`, and nothing is added. A `mist` whose id matches no plugin Evi has loaded throws an `UnknownPluginError`. Both classes are exported from `@aurologic/mist-api/ui`. `chatBar.add` hands the plugin no message and needs nothing.

Like Evi's guard, this check catches what an honest plugin forgot to declare; it isn't a sandbox. [What the check is for](security.md#what-the-check-is-for) has the details.

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

The first time each distinct error is caught, it is logged with `name`, through `mist.log` when `mist` is given and through `console.error` otherwise. The same error again is not logged: a component that throws on every render logs once. After 50 distinct errors in one log, it logs `mist ui: 50 distinct errors logged; further errors suppressed` once and then stops, which keeps a quiet log from passing for a healthy plugin. Errors of the [message listeners](#messages) are logged by the same rule.

`boundary(Component, options)` wraps a component in a `Boundary`, for a component that you hand to Discord or a patch. `name` defaults to the component's name.

```tsx
export const SafePanel = boundary(Panel, { mist, fallback: null });
```

A boundary catches errors during rendering only, as React's error boundaries do. Errors in event handlers, timers, and promises aren't caught.

## state

```ts
interface Readable<T> extends ChangeSource {
	get(): T;
}

interface State<T> extends Readable<T> {
	set(value: T): void;
	update(fn: (current: T) => T): void;
	use(): T;
	onChange(listener: (value: T) => void): () => void;
}

function state<T>(initial: T): State<T>;
function useValue<T>(source: Readable<T>): T;
```

`state(initial)` is one value that a plugin's UI and the rest of its code share. Its members match [`mist.data`](core.md#mistdata)'s:

- `get()` is the current value.
- `set(value)` stores `value` and tells the listeners, but only when it differs from the current value by `Object.is`.
- `update(fn)` sets the result of `fn` applied to the current value. Return a new object rather than changing `current` in place: an object changed in place is the same value by `Object.is`, and no listener hears it.
- `use()` is a React hook that returns the value and renders the component again on each change. It is the same as `useValue(state)`.
- `onChange(listener)` calls `listener` with the new value on each change, until you call the function it returns.

`useValue(source)` is the hook for any `Readable`, such as a `State` or a `mist.data` object. A `State` is also a `ChangeSource`, and [`useStore` and `subscribe`](stores.md) take it like a Flux store:

```tsx
const unread = state(0);

export default mist.define({
	start(ctx) {
		ctx.onDispose(unread.onChange(n => mist.log.info("unread", n)));
	},
});

function Badge() {
	const label = useStore(unread, () => `${unread.get()} unread`);
	return <span>{label}</span>;
}
```

A `state` lives in one copy of the plugin's code, and a hot reload starts with a new one. To keep a value across a hot reload, or to share it between plugins, use a [slot](bus.md#slot). To keep it across restarts, use [`mist.data`](core.md#mistdata).

## host

```ts
interface Host<P> {
	readonly Component: ComponentType<P>;
	set(owner: Owner, Component: ComponentType<P>, options?: { fallback?: Fallback; }): () => void;
}

function host<P extends object = {}>(name: string): Host<P>;
```

Discord keeps the component that a patch handed it. After a hot reload, that component is still the stopped copy's, which reads the stopped copy's state. `host(name)` solves this. `Component` is the same component in every copy of the plugin and every copy of mist-api, and a patch can hand it to Discord once. It renders the component that the running copy passed to `set`, inside a `Boundary`, and renders nothing while the plugin is stopped.

`set` returns a function that clears the host. Stopping the plugin clears it too. A new start's `set` replaces the old one, and the old run's late cleanup doesn't clear the new component. Each `set` renders inside a new `Boundary`: a component that a hot reload fixed renders at once instead of staying behind the old one's fallback.

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
- The registry's state is on `globalThis` under a `Symbol.for("mist-api.ui/<name>@1")` key. Plugins that bundle different copies of mist-api share one registry. The first copy's functions serve every copy until Discord reloads.
- Each entry renders inside a `Boundary` named `<plugin id>/<entry id>`. Adding an id that the plugin already used replaces that entry. Each add gets a new boundary: an entry that a hot reload adds again starts without the old entry's error.
- `fallback` is what an entry shows when it throws while rendering. Left out, or `undefined`, it is nothing for a button, where a notice wouldn't fit, and the boundary's notice for an accessory.
- `add` and the message functions return a function that removes the entry. Stopping the plugin removes it too.
- Each takes the plugin's `mist` as its owner. `popover`, `accessories`, and `messages` need `readMessages`, as [Permissions](#permissions) describes.

The patches are marked [`onDemand`](core.md#ondemand), because Discord loads the chat and message code only when a channel opens. Until then, `mist status` shows them as waiting.

### chatBar

```ts
interface ChatBarProps {
	channel: Channel;
	disabled?: boolean;
	type?: { analyticsName?: string; };
}

chatBar.add(mist: MistOwner, id: string, Component: ComponentType<ChatBarProps>, options?: { fallback?: Fallback; }): () => void;

function ChatBarButton(props: { label: string; onClick(event: MouseEvent): void; active?: boolean; children: ReactNode; }): ReactElement;
```

Adds a button to the chat bar, after Discord's gift, GIF, sticker, emoji, and apps buttons and before the send button. The component gets the props that Discord gives its buttons. `type.analyticsName` is `"normal"` in a channel's chat bar. Return `null` to show nothing, for example in a thread or a DM where the button doesn't fit.

`ChatBarButton` looks like Discord's buttons. Its children are the icon, about 20 by 20 pixels. If Discord renames its button, `ChatBarButton` falls back to a plain button.

A chat bar button that throws shows nothing unless you pass a `fallback`.

### popover

```ts
interface PopoverProps {
	message: Message;
	channel: Channel;
	Button: ComponentType<{ label: string; icon: ComponentType<{ className?: string; }>; onClick(event: MouseEvent): void; dangerous?: boolean; disabled?: boolean; separator?: boolean; }>;
}

popover.add(mist: MistOwner, id: string, Component: ComponentType<PopoverProps>, options?: { fallback?: Fallback; }): () => void;
```

Adds a button to the hover bar of every message, before the quick reactions. Render `props.Button`, which is Discord's hover bar button, with your label, icon, and click handler:

```tsx
popover.add(mist, "copy-text", ({ Button, message }) =>
	message.content ? <Button label="Copy text" icon={CopyIcon} onClick={() => copy(message.content)} /> : null);
```

A hover bar button that throws shows nothing unless you pass a `fallback`.

### accessories

```ts
interface AccessoryProps {
	message: Message;
	channel: Channel;
}

accessories.add(mist: MistOwner, id: string, Component: ComponentType<AccessoryProps>, options?: { fallback?: Fallback; }): () => void;
```

Adds UI under every message, after its embeds, attachments, and reactions. The component renders for each message on screen. Return `null` quickly for the messages it isn't for, and keep the work for the others in `useStore` or `useMemo`.

An accessory that throws shows the boundary's notice by default. UI that disappears without a trace under a message looks like a missing feature.

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

messages.beforeSend(mist: MistOwner, id: string, listener: (draft: SendDraft) => Verdict | Promise<Verdict>): () => void;
messages.beforeEdit(mist: MistOwner, id: string, listener: (draft: EditDraft) => Verdict | Promise<Verdict>): () => void;
```

`beforeSend` runs the listener before each message that the user sends from the chat box. `beforeEdit` runs it before each edit that the user saves. Spread `messages.patches` into the plugin's `patches` for either one.

The listeners run after Discord has checked the message. They don't run for a message that Discord turns down, such as one sent during slow mode. They run one at a time, in `<plugin id>/<entry id>` order, and the message waits for each one: a listener can be `async`. A listener changes what is sent or saved by setting `draft.content`. Discord then handles the new content as it does what the user typed.

Each listener gets a separate copy of the draft. Its `content` is taken only when the listener settles in time without throwing, and the next listener gets a copy with that content. A listener's changes are dropped in these cases, and the message goes on with the content from before that listener:

- It doesn't settle within 5 seconds. Its plugin logs `<plugin id>/<entry id> didn't finish within 5 s; the message goes on without it` once, and the next listener runs. A listener that never settles can't hold up sending.
- It throws or rejects. Its plugin logs the error once.
- It sets `content` to something other than a string. Its plugin logs that once.

A dropped listener can't change the message later either, when it finishes in the background: it only ever held its copy.

A listener that returns `{ cancel: true }` stops the message, and the listeners after it don't run. Discord keeps the text in the message box, or the edit open, with the focus there, and the user can change it and try again.

With no listeners, the patched code goes on at once: a plain message isn't delayed.

These listeners see messages typed in the chat box and edits saved in Discord's editor. They don't see messages that other code, such as another plugin, sends through Discord's API.

## Settings pieces

```ts
function Button(props: {
	children?: ReactNode;
	onClick?(event: MouseEvent<HTMLButtonElement>): void;
	variant?: "primary" | "secondary" | "danger" | "link";
	size?: "small" | "medium" | "large";
	disabled?: boolean;
	busy?: boolean;
	label?: string;
	type?: "button" | "submit";
}): ReactElement;
function Switch(props: {
	checked: boolean;
	onChange(checked: boolean): void;
	label?: ReactNode;
	description?: ReactNode;
	disabled?: boolean;
	className?: string;
	id?: string;
	"aria-label"?: string;
}): ReactElement;
function TextInput(props: {
	value: string;
	onChange(value: string): void;
	label?: ReactNode;
	description?: ReactNode;
	placeholder?: string;
	disabled?: boolean;
	readOnly?: boolean;
	maxLength?: number;
	type?: "text" | "password" | "search" | "url" | "number";
	invalid?: boolean;
	className?: string;
	id?: string;
	name?: string;
	"aria-label"?: string;
	onKeyDown?(event: KeyboardEvent<HTMLInputElement>): void;
	onBlur?(event: FocusEvent<HTMLInputElement>): void;
	onFocus?(event: FocusEvent<HTMLInputElement>): void;
}): ReactElement;
function Tip(props: { text: string; position?: "top" | "bottom" | "left" | "right"; children: ReactElement; }): ReactElement;
function Card(props: { children?: ReactNode; }): ReactElement;
function Row(props: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; }): ReactElement;
function Callout(props: { tone?: "info" | "warning" | "danger" | "success"; title?: ReactNode; children?: ReactNode; }): ReactElement;
```

Pieces for a plugin's `settingsPanel` that look like Discord's settings and keep working when Discord renames one of its components.

- `Button` renders Discord's button through Evi's `Components.Button` when Evi finds it, with Discord's colour for the `variant` (default `"secondary"`) and its `size` (default `"small"`). Without it, it renders a plain `<button>` styled like Discord's. A `"link"` button is always the plain one, styled as a link. `busy` disables the button and sets `aria-busy`, and Discord's button shows its spinner. `label` is the accessible name, for a button whose text doesn't say what it does.
- `Switch` is a toggle. It renders Discord's switch through Evi's `Components.Switch` when Evi finds it and the switch has a name, from `label` or `aria-label`. Otherwise it renders a styled `<button role="switch">`. With a `label` or a `description`, it is a settings row: the text on the left and the switch on the right. Without either, it is the bare switch, and `aria-label` names it. `className` goes on the outermost element, and `id` is the switch's, generated when you leave it out.
- `TextInput` is a one-line text box in Discord's input colours. `onChange` gets the new text. With a `label` or a `description`, it is a settings field: the label above the input, tied to it with `<label for>`, and the description under the label, read to screen readers with `aria-describedby`. Without either, it is the bare input, and `aria-label` names it. `invalid` gives it a red border and sets `aria-invalid`. It is always a plain `<input>`, never Discord's `Components.TextField`, which doesn't promise to pass on `readOnly`, `name`, or the key and focus handlers.
- `Tip` shows `text` in Discord's tooltip, through Evi's `Components.Tooltip`, when the pointer or focus is on `children`. Without it, it sets `children`'s `title` attribute. `children` must therefore be one element that takes a `title`, such as a `<span>` or a `<button>`.
- `Card` groups content on Discord's raised background, with a border.
- `Row` is a settings row: `title` and `description` on the left, `actions` on the right, and `children` under it across the full width.
- `Callout` is a coloured note with `role="note"`, in Discord's colour for its `tone` (default `"info"`), with an optional `title`.

The styled pieces share one stylesheet. It is added to the page when the first one mounts and removed when the last one unmounts, also across plugins that bundle different copies of mist-api. It uses Discord's CSS variables, with fallbacks, and follows Discord's light and dark themes. Every class name starts with `mist-`.

The settings panel below saves the city when the field loses focus or the user presses Enter, not on every keystroke, and clears the busy state even when signing in fails:

```tsx
const city = mist.data("city", "");

function Settings() {
	const [busy, setBusy] = React.useState(false);
	const [draft, setDraft] = React.useState(city.get());
	const signedIn = useValue(account) !== null;
	const inStatus = mist.settings.use("showInStatus");

	async function toggle() {
		setBusy(true);
		try {
			await toggleLogin();
		} finally {
			setBusy(false);
		}
	}
	const saveCity = () => city.set(draft.trim());

	return (
		<Card>
			<Row
				title="Weather service"
				description={signedIn ? "Signed in" : "Sign in to see the forecast in your status."}
				actions={<Button variant={signedIn ? "secondary" : "primary"} busy={busy} onClick={() => void toggle()}>{signedIn ? "Sign out" : "Sign in"}</Button>}
			/>
			<Switch label="Show in status" description="Puts the temperature in your custom status." checked={inStatus} onChange={on => mist.settings.set("showInStatus", on)} />
			<TextInput label="City" description="Where the forecast is for." value={draft} onChange={setDraft} onBlur={saveCity} onKeyDown={event => event.key === "Enter" && saveCity()} />
			{!signedIn && <Callout tone="warning">The forecast stays empty until you sign in.</Callout>}
		</Card>
	);
}
```

## Shared state and versions

The key of each registry ends in `@1`, the protocol version of its shared state. A copy that finds a key that holds state it can't read throws `mist ui: mist-api.ui/<name>@1 was made by an incompatible copy`. When the shape of the shared state changes, mist-api raises the version, and copies of each version then keep separate registries.
