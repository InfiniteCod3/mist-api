// Run by cli.test.ts under Node: mist flux and mist store against a page with Discord's dispatcher and stores, over node:inspector
import { Session } from "node:inspector/promises";

import type { Send } from "../../bin/cdp.ts";
import { type FluxBatch, stopFlux, watchFlux } from "../../bin/flux.ts";
import { DISPLAY } from "../../bin/page.ts";
import { callStore, listStore } from "../../bin/store.ts";

type Action = { type: string; [key: string]: unknown; };
type Handler = (action: Action) => unknown;

/** Discord's dispatcher as far as mist reads it: interceptors first, skipping the action on true, then subscribers */
class Dispatcher {
    _interceptors: Handler[] = [];
    _subscriptions: Record<string, Set<Handler>> = {};
    addInterceptor(fn: Handler) { this._interceptors.push(fn); }
    subscribe(type: string, fn: Handler) { (this._subscriptions[type] ??= new Set()).add(fn); }
    unsubscribe(type: string, fn: Handler) {
        this._subscriptions[type]?.delete(fn);
        if (!this._subscriptions[type]?.size) delete this._subscriptions[type];
    }
    dispatch(action: Action) {
        for (const fn of this._interceptors) if (fn(action)) return;
        this._subscriptions[action.type]?.forEach(fn => fn(action));
    }
}

class Store {
    getDispatchToken() { return "token-1"; }
    emitChange() { }
}
let sets = 0;
class ThingStore extends Store {
    getThing(id: string) { return { id, name: "thing", authToken: "do-not-show", tags: Array.from({ length: 30 }, (_, i) => i) }; }
    isOn() { return true; }
    getAuthToken() { return "do-not-show"; }
    getTokens() { return 3; }
    getOrCreateThing() { return {}; }
    setThing() { sets++; }
    getState() { return { things: {}, selected: null }; }
}
const stores: Record<string, object> = { ThingStore: new ThingStore() };

const D = new Dispatcher();
(globalThis as any).Evi = { api: { Dispatcher: D, findStore: (name: string) => stores[name] } };

const session = new Session();
session.connect();
const send: Send = (method, params) => session.post(method as any, params as any);
const later = (ms: number, fn: () => void) => setTimeout(fn, ms);
const listeners = () => ({ interceptors: D._interceptors.length, subscriptions: Object.keys(D._subscriptions) });
const failure = (promise: Promise<unknown>) => promise.then(() => null, (err: Error) => err.message);

async function watch(options: Parameters<typeof watchFlux>[1]) {
    const batches: FluxBatch[] = [];
    await watchFlux(send, { pollMs: 20, ...options }, batch => batches.push(batch));
    return { records: batches.flatMap(b => b.records), dropped: batches.reduce((n, b) => n + b.dropped, 0), alive: batches.map(b => b.alive) };
}

const scenarios: Record<string, () => Promise<unknown>> = {
    async types() {
        later(5, () => {
            D.dispatch({ type: "A", n: 1, token: "secret-1" });
            D.dispatch({ type: "B", n: 9 });
            D.dispatch({ type: "A", n: 2 });
            D.dispatch({ type: "A", n: 3 });
        });
        const seen = await watch({ types: ["A"], count: 2, limits: DISPLAY });
        return { seen, after: listeners() };
    },
    async every() {
        const other: string[] = [];
        later(5, () => {
            D.addInterceptor(action => void other.push(action.type));
            for (const type of ["A", "B", "C", "D"]) D.dispatch({ type });
        });
        const seen = await watch({ types: [], count: 3, limits: DISPLAY });
        await new Promise(resolve => setTimeout(resolve, 10));
        return { seen, other, after: listeners() };
    },
    async interrupted() {
        let polls = 0;
        later(5, () => D.dispatch({ type: "A" }));
        const seen = await watch({ types: ["A"], count: null, limits: DISPLAY, stopped: () => polls++ > 3 });
        return { seen, after: listeners() };
    },
    async abandoned() {
        // The CLI reads every 200 ms, the page drops a watch it hasn't read for 50
        let polls = 0;
        const seen = await watch({ types: ["A"], count: null, limits: DISPLAY, pollMs: 200, ttlMs: 50, stopped: () => polls++ > 5 });
        return { seen, after: listeners() };
    },
    async flood() {
        let polls = 0;
        later(5, () => { for (let n = 0; n < 1005; n++) D.dispatch({ type: "A", n }); });
        const seen = await watch({ types: ["A"], count: null, limits: DISPLAY, pollMs: 50, stopped: () => polls++ > 0 });
        return { first: seen.records[0]?.payload, kept: seen.records.length, dropped: seen.dropped };
    },
    async stopTwice() {
        return [await stopFlux(send, "no-such-watch"), listeners()];
    },
    async store() {
        return {
            methods: await listStore(send, "ThingStore"),
            thing: (await callStore(send, "ThingStore", "getThing", ["7"], DISPLAY)).result,
            on: (await callStore(send, "ThingStore", "isOn", [], DISPLAY)).result,
            token: (await callStore(send, "ThingStore", "getAuthToken", [], DISPLAY)).result,
            tokens: (await callStore(send, "ThingStore", "getTokens", [], DISPLAY)).result,
            set: await failure(callStore(send, "ThingStore", "setThing", [], DISPLAY)),
            create: await failure(callStore(send, "ThingStore", "getOrCreateThing", [], DISPLAY)),
            missingStore: await failure(listStore(send, "NoStore")),
            missingMethod: await failure(callStore(send, "ThingStore", "getNothing", [], DISPLAY)),
            sets,
        };
    },
};

console.log(JSON.stringify(await scenarios[process.argv[2]]()));
session.disconnect();
