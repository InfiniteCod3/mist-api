# Events

Evi's native side can't push to the page. The page asks, and main answers. An event channel lets the native side send events to the page anyway. The native side keeps a log of events, and the page reads it with a long poll that mist-api runs for you.

```ts
import { defineNative, nativeEvents } from "@aurologic/mist-api/native";
```

```ts
mist.events.subscribe(listener, { onConnect });
```

## Example

This invented Notes plugin keeps notes in its native side. The page shows the list and a toast when a note is saved.

`native.ts`:

```ts
import { defineNative, nativeEvents } from "@aurologic/mist-api/native";

export type NoteEvent =
	| { type: "saved"; id: string; title: string; }
	| { type: "deleted"; id: string; }
	| { type: "toast"; text: string; };

const notes = new Map<string, string>();

const events = nativeEvents<NoteEvent>({
	keep: 500,
	// A page that reloads gets the changes from before, not the old toasts
	replay: event => event.type !== "toast",
});

export default defineNative({
	list(): { id: string; title: string; }[] {
		return [...notes].map(([id, title]) => ({ id, title }));
	},
	save(id: string, title: string) {
		if (typeof id !== "string" || typeof title !== "string") throw new Error("Bad note");
		notes.set(id, title);
		events.push({ type: "saved", id, title });
		events.push({ type: "toast", text: `Saved ${title}` });
	},
}, { events });
```

`index.tsx`:

```tsx
import { createMist } from "@aurologic/mist-api";

import type native from "./native";

export const mist = createMist<{}, typeof native>("notes");

let shown: { id: string; title: string; }[] = [];

export default mist.define({
	start(ctx) {
		mist.events.subscribe(event => {
			if (event.type === "saved") shown = [...shown.filter(n => n.id !== event.id), { id: event.id, title: event.title }];
			else if (event.type === "deleted") shown = shown.filter(n => n.id !== event.id);
			else ctx.toast(event.text);
		}, {
			onConnect: async () => { shown = await mist.native.list(); },
		});
	},
});
```

The listener's type comes from the native module, so `event` is a `NoteEvent`.

## nativeEvents

```ts
function nativeEvents<E>(options?: NativeEventsOptions<E>): NativeEvents<E>;

interface NativeEventsOptions<E> {
	keep?: number;
	replay?: (event: E) => boolean;
	live?: (event: E) => boolean;
	waitMs?: number;
}

interface NativeEvents<E> {
	push(event: E): void;
}
```

Makes a channel. Make it once, at module level in `native.ts`, and pass it to `defineNative` as `events`.

| Option | Default | Effect |
| --- | --- | --- |
| `keep` | `1000` | How many events the log keeps. Older ones are dropped. It must be a positive integer. |
| `replay` | none | Which events a page gets from before it connected. Use it for events that describe state, and leave out one-time events such as a toast or a sound. |
| `live` | all | Checked each time an event is handed out. An event it rejects is left out of that answer. Use it for an event that stops being true after it is pushed, such as a request that was answered. |
| `waitMs` | `25000` | How long a poll waits for an event before it answers empty. |

`push` gives each event the next sequence number and wakes every waiting poll. Events cross Electron's IPC, so push plain data that structured clone can copy.

`defineNative` throws `defineNative's events must come from nativeEvents` for any other object.

## mist.events.subscribe

```ts
subscribe(listener: (event: E) => void, options?: SubscribeOptions): () => void;

interface SubscribeOptions {
	onConnect?: () => unknown;
	retryMs?: number;
}
```

Calls `listener` with each event, in push order, each one once. Call it while the plugin runs, such as in `start`. It throws the `mist.ctx` error when the plugin isn't running.

It returns a function that ends the subscription. The subscription also ends when the run is disposed, so a plugin doesn't need to call it on stop. After it ends, no new poll starts, and the answer of a poll in flight is ignored.

`onConnect` loads the page's state. It runs before the first events are delivered, and again each time the page has to load its state again. It can return a promise, and no events are delivered until it settles. If it throws or rejects, the subscription waits `retryMs` and connects again. `retryMs` also applies after a failed poll. Its default is `2000`.

A listener that throws doesn't stop the subscription. Each distinct failure is logged once through `mist.log`, as `mist.safe` does.

Each call to `subscribe` runs its own poll. Two subscribers each get every event.

When the plugin's native module has no channel, `subscribe` takes no listener, so the typecheck fails.

## Connecting and restarts

A page connects when it subscribes. Its first poll answers at once. Then `onConnect` runs, and then the listener gets the events from the log that `replay` accepts. From then on, each poll answers with every event pushed after the last answer. When nothing new is in the log, it waits for up to `waitMs`.

The page loads its state again, by running `onConnect` and then getting the replayed events, in these cases:

- It just subscribed.
- The native side restarted. Each run of the native side has its own boot id, sent with each answer. A `start` after a `stop` empties the log and draws a new boot id, so a page that polls with the old id connects again. A page that reloads connects again in the same way.
- The page fell behind. When the events after its last answer are no longer in the log, because more than `keep` were pushed since, it connects again instead of missing them.

An event pushed while `onConnect` runs comes in the next answer, so it isn't lost.

## Stop

The native module's `stop` runs your `stop` and then answers every waiting poll at once, with no events. A poll while the native side is stopped fails with `The native side is stopped`, and the page tries again after `retryMs`. A poll never hangs until `waitMs` because the native side stopped.

## Recording

The poll is a hidden native method, `__mist_events`. Its calls are counted on both sides and not kept in the call rings, like a `quiet` method's. `mist status` shows the page side's count, as in `quiet calls, counted and not kept: __mist_events 12`, and `mist native-logs` shows the native side's. A poll that fails is kept like any other call.

## Transport

The page long-polls over Evi's `ctx.native.call`. The page never sees a cursor, a boot id, or a poll, so the transport can change without changes to plugin code.
