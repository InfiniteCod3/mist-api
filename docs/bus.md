# Bus

`@aurologic/mist-api/bus` passes data between plugins on the page, and between two copies of one plugin across a hot reload. It has two kinds of shared state. A `channel` delivers events and keeps nothing. A `slot` holds one current value.

```ts
import { type BusChannel, channel, type Slot, slot } from "@aurologic/mist-api/bus";
```

## How copies share state

Each plugin bundles a copy of mist-api, and a module-level variable in one copy is invisible to the others. The bus keeps its state on `globalThis` under a `Symbol.for` key instead:

```text
Symbol.for("mist-api.bus/channel/<name>@<version>")
Symbol.for("mist-api.bus/slot/<name>@<version>")
```

The shared state holds only data: a set of listeners and, for a slot, the current value. Each copy brings its methods. The first copy to use a name and version creates the state as a non-writable, non-configurable property, and every later copy uses it.

The name and the version together are the protocol between plugins. When the shape of the payload changes, raise the version. Old and new then use different keys and never see each other's values. mist-api's version plays no part.

A user can update one plugin and not the other. The two then sit on different versions and stop hearing each other. Declare the protocol in `createMist`'s `provides` and `needs` options, and mist-api tells the user which plugin to update, as [Plugins that depend on each other](core.md#plugins-that-depend-on-each-other) describes.

Errors start with the kind and, once known, the name and version:

| Case | Throws |
| --- | --- |
| An empty or missing name | `TypeError`: `channel: name must be a non-empty string, got ""` |
| A version that isn't a number | `TypeError`: `slot: version must be a number, got "2"` |
| A version that isn't a whole number of 1 or more | `RangeError`: `channel: version must be a whole number from 1, got 0` |
| A key that holds state this copy can't read | `TypeError`: `slot units-api@1 was made by an incompatible copy of mist-api` |

Both functions take an optional third argument, `root`, which defaults to `globalThis`. Tests pass a fresh object.

## channel

```ts
interface BusChannel<T> {
	publish(value: T): void;
	subscribe(listener: (value: T) => void): () => void;
}

function channel<T>(name: string, version: number, root?: object): BusChannel<T>;
```

Events between plugins. `publish` calls every listener subscribed at that moment, in every copy, in the order they subscribed. Nothing is kept: a listener that subscribes after a `publish` never gets that value. `subscribe` returns a function that removes the listener.

A listener that throws doesn't stop the other listeners, and `publish` doesn't throw. The error is printed with `console.error` as `channel <name>@<version>: a listener (<function name>) threw`, without the value, which may be private.

```ts
interface Reading { place: string; temperature: number; }

const forecast = channel<Reading>("forecast", 1);
const off = forecast.subscribe(reading => mist.log.info(reading.place, reading.temperature));
forecast.publish({ place: "Berlin", temperature: 11.8 });
off();
```

## slot

```ts
interface Slot<T> {
	get(): T | undefined;
	set(value: T): () => void;
	subscribe(listener: (value: T | undefined) => void): () => void;
}

function slot<T>(name: string, version: number, root?: object): Slot<T>;
```

One shared value, such as an API that a running plugin offers to others.

- `get()` returns the current value, or `undefined` when there is none.
- `set(value)` makes `value` the current one, calls every listener with it, and returns a release function.
- The release function clears the slot and calls every listener with `undefined`, but only if the slot still holds the value from that `set`. If another `set` has run since, release does nothing. An old copy that stops late, after a hot reload, doesn't clear the value its newer copy set.
- `subscribe` calls its listener on every later `set` and release. It doesn't call it with the current value: call `get()` for that.

Listeners that throw are handled as in `channel`, with `slot <name>@<version>` in the message.

Set the slot on start and release it on stop:

```ts
interface UnitsApi { current(): "metric" | "imperial"; }

const unitsApi = slot<UnitsApi>("units-api", 1);

export default mist.define({
	start(ctx) {
		const release = unitsApi.set({ current: () => "metric" });
		ctx.onDispose(release);
	},
});
```

Another plugin reads it:

```ts
const unitsApi = slot<UnitsApi>("units-api", 1);
const units = unitsApi.get()?.current() ?? "metric";
const stop = unitsApi.subscribe(api => mist.log.info(api ? "units api is up" : "units api is gone"));
```

Every plugin on the page can read and set every slot and publish on every channel. Don't put a secret on the bus, or a function that does something only its owner should do.
