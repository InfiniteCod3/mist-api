/** mist store: lists a Flux store's methods, or calls one that only reads */
import { CdpError, evaluate, type Send } from "./cdp.ts";
import { type Limits, pageExpression } from "./page.ts";

/**
 * A method name that says it reads: get, is, has, find, can, should, are, or supports, then a capital
 * or nothing. Discord has getters that change state too, named getOrCreate... and getAndDelete...
 */
export const readable = (method: string) => /^(get|is|has|find|can|should|are|supports)([A-Z]|$)/.test(method) && !/^[a-z]+(Or|And)[A-Z]/.test(method);

export interface StoreMethods { store: string; methods: { name: string; readable: boolean; }[]; stateKeys: string[] | null; }
export interface StoreResult { store: string; method: string; result: unknown; }

/** Page side. Leaves out the base Flux Store's own methods, which every store has. */
function read(snapshot: (value: unknown, limits: Limits) => unknown, name: string, method: string | null, args: unknown[], limits: Limits | null) {
    const store = (globalThis as any).Evi.api.findStore(name);
    if (!store) return { error: `No Flux store is named ${name}. Store names are Discord's, as in UserStore or SelectedChannelStore.` };
    if (method === null) {
        const names = new Set<string>();
        for (let proto = Object.getPrototypeOf(store); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
            if (Object.hasOwn(proto, "getDispatchToken")) break;
            for (const key of Object.getOwnPropertyNames(proto)) {
                if (key !== "constructor" && typeof Object.getOwnPropertyDescriptor(proto, key)?.value === "function") names.add(key);
            }
        }
        let stateKeys: string[] | null = null;
        if (typeof store.getState === "function") {
            try {
                const state = store.getState();
                stateKeys = state && typeof state === "object" ? Object.keys(state) : null;
            } catch { }
        }
        return { store: name, methods: [...names].sort(), stateKeys };
    }
    if (typeof store[method] !== "function") return { error: `${name} has no method ${method} (mist store ${name} lists them)` };
    // The method's name names its result, as a field's name does: getToken's answer is masked like a token field
    const named = snapshot({ [method]: store[method](...args) }, { ...limits!, depth: limits!.depth + 1 }) as Record<string, unknown>;
    return { store: name, method, result: named[method] };
}

async function answer<T>(send: Send, expression: string): Promise<T> {
    const found = await evaluate<T | { error: string; }>(send, expression);
    if (found && typeof found === "object" && "error" in found) throw new CdpError(found.error);
    return found as T;
}

export async function listStore(send: Send, name: string): Promise<StoreMethods> {
    const found = await answer<{ store: string; methods: string[]; stateKeys: string[] | null; }>(send, pageExpression(read, [name, null, [], null], true));
    return { ...found, methods: found.methods.map(method => ({ name: method, readable: readable(method) })) };
}

export async function callStore(send: Send, name: string, method: string, args: unknown[], limits: Limits): Promise<StoreResult> {
    if (!readable(method)) throw new CdpError(`${method} isn't named as a read, so it could change ${name}. mist store calls methods named get, is, has, find, can, should, are, or supports and a capital letter, other than getOr and getAnd ones such as getOrCreate.`);
    return answer(send, pageExpression(read, [name, method, args, limits], true));
}
