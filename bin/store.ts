/** mist store: lists a Flux store's methods, or calls one that only reads */
import { CliError, type Send } from "./cdp.ts";
import { type Limits, type PageError, type PageGlobal, pageCall } from "./page.ts";

/**
 * A method name that says it reads: get, is, has, find, can, should, are, or supports, then a capital
 * or nothing. Discord has getters that change state too, named getOrCreate... and getAndDelete...
 */
export const readable = (method: string) => /^(get|is|has|find|can|should|are|supports)([A-Z]|$)/.test(method) && !/^[a-z]+(Or|And)[A-Z]/.test(method);

export interface StoreMethods { store: string; methods: { name: string; readable: boolean; }[]; stateKeys: string[] | null; }
export interface StoreResult { store: string; method: string; result: unknown; }

type FluxStore = Record<string, unknown>;
type StorePage = PageGlobal<{ Evi: { api: { findStore(name: string): FluxStore | undefined; }; }; }>;

/** Page side. Leaves out the base Flux Store's methods, which every store has. */
function listPage(name: string): { store: string; methods: string[]; stateKeys: string[] | null; } | null {
    const store = (globalThis as StorePage).Evi.api.findStore(name);
    if (!store) return null;
    const names = new Set<string>();
    for (let proto = Object.getPrototypeOf(store); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        if (Object.hasOwn(proto, "getDispatchToken")) break;
        for (const key of Object.getOwnPropertyNames(proto)) {
            if (key !== "constructor" && typeof Object.getOwnPropertyDescriptor(proto, key)?.value === "function") names.add(key);
        }
    }
    let stateKeys: string[] | null = null;
    const getState = store.getState;
    if (typeof getState === "function") {
        try {
            const state = getState.call(store);
            stateKeys = state && typeof state === "object" ? Object.keys(state) : null;
        } catch { }
    }
    return { store: name, methods: [...names].sort(), stateKeys };
}

/** Page side */
function callPage(snapshot: (value: unknown, limits: Limits) => unknown, name: string, method: string, args: unknown[], limits: Limits): StoreResult | PageError | null {
    const store = (globalThis as StorePage).Evi.api.findStore(name);
    if (!store) return null;
    const fn = store[method];
    if (typeof fn !== "function") return { error: `${name} has no method ${method} (mist store ${name} lists them)` };
    // The method's name names its result, as a field's name does: getToken's answer is masked like a token field
    const named = snapshot({ [method]: fn.apply(store, args) }, { ...limits, depth: limits.depth + 1 }) as Record<string, unknown>;
    return { store: name, method, result: named[method] };
}

const noStore = (name: string) => new CliError(`No Flux store is named ${name}. Store names are Discord's, as in UserStore or SelectedChannelStore.`);

export async function listStore(send: Send, name: string): Promise<StoreMethods> {
    const found = await pageCall(send, listPage, [name]);
    if (!found) throw noStore(name);
    return { ...found, methods: found.methods.map(method => ({ name: method, readable: readable(method) })) };
}

export async function callStore(send: Send, name: string, method: string, args: unknown[], limits: Limits): Promise<StoreResult> {
    if (!readable(method)) throw new CliError(`${method} isn't named as a read and could change ${name}. mist store calls only get, is, has, find, can, should, are and supports methods, not getOr or getAnd ones.`);
    const found = await pageCall(send, callPage, [name, method, args, limits], true);
    if (!found) throw noStore(name);
    return found;
}
