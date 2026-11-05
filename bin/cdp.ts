/** The Chrome DevTools Protocol side of the CLI. Each function takes a `send`, so tests/cdp.test.ts runs them over node:inspector. */

export type Send = (method: string, params?: Record<string, unknown>) => Promise<any>;

interface RemoteObject { type: string; value?: unknown; objectId?: string; description?: string; }
interface Evaluated { result: RemoteObject; exceptionDetails?: { text?: string; exception?: RemoteObject; }; }

export class CdpError extends Error { }

function unwrap(answer: Evaluated): RemoteObject {
    if (answer.exceptionDetails) {
        const { exception, text } = answer.exceptionDetails;
        throw new CdpError(exception?.description ?? text ?? "Evaluation failed");
    }
    return answer.result;
}

/** Evaluates `expression` in the page, awaiting a promise, and returns its value as JSON */
export async function evaluate<T = unknown>(send: Send, expression: string): Promise<T> {
    const answer: Evaluated = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return unwrap(answer).value as T;
}

/** Calls `fn` with `this` bound to a remote object; arguments and the result travel as JSON */
export async function callOn<T = unknown>(send: Send, objectId: string, fn: string, args: unknown[] = []): Promise<T> {
    const answer: Evaluated = await send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: fn,
        arguments: args.map(value => ({ value })),
        returnByValue: true,
        awaitPromise: true,
    });
    return unwrap(answer).value as T;
}

const REGISTRY = `globalThis[Symbol.for("mist-api.registry.v1")]`;

interface Properties { privateProperties?: { name: string; value?: RemoteObject; }[]; }

/**
 * A plugin's debug capability (see src/debug.ts), held in its handle's one private field. Page code
 * can't read a private field or make one hold the capability; Runtime.getProperties lists it. The
 * objectId belongs to `group`; release it with releaseGroup.
 */
export async function capability(send: Send, plugin: string, group: string): Promise<string> {
    const found: Evaluated = await send("Runtime.evaluate", {
        expression: `${REGISTRY}?.get(${JSON.stringify(plugin)})`,
        objectGroup: group,
    });
    const handle = unwrap(found).objectId;
    if (!handle) throw new CdpError(`${plugin} isn't a mist-api plugin on this page (mist status lists them)`);
    const { privateProperties = [] }: Properties = await send("Runtime.getProperties", { objectId: handle, ownProperties: true });
    const id = privateProperties.length === 1 ? privateProperties[0].value?.objectId : undefined;
    if (!id) {
        const version = await callOn<unknown>(send, handle, "function () { return this.mistVersion; }").catch(() => "unknown");
        throw new CdpError(`${plugin}'s handle holds no debug capability this CLI can read (it has ${privateProperties.length} private fields, mist-api ${version}). Rebuild the plugin with this mist-api.`);
    }
    return id;
}

/**
 * Why the registry says not to trust the plugin's handle, read from the registry itself rather than
 * window.Mist. null when the registry keeps no history. A handle that says its plugin is stopped
 * gets a concern too: the plugin's own capability would refuse a call then, so only a stand-in takes one.
 */
export async function concerns(send: Send, plugin: string): Promise<string[] | null> {
    return await evaluate<string[] | null>(send, `(() => {
        const registry = ${REGISTRY};
        const id = ${JSON.stringify(plugin)};
        if (typeof registry?.concerns !== "function") return null;
        const found = registry.concerns(id);
        let running = false;
        try { running = registry.get(id)?.state().running === true; } catch { }
        return running ? found : [...found, id + "'s handle says the plugin isn't running"];
    })()`);
}

export const releaseGroup = (send: Send, group: string) => send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => { });

interface Target { type: string; url: string; title: string; webSocketDebuggerUrl?: string; }

/** Discord pages among the debugging port's targets, the main app first */
export function discordPages(targets: Target[]): Target[] {
    const pages = targets.filter(t => t.type === "page" && t.webSocketDebuggerUrl && /^https:\/\/(?:\w+\.)?discord\.com\//.test(t.url));
    const main = (t: Target) => /^https:\/\/(?:\w+\.)?discord\.com\/(?:app|channels)\b/.test(t.url) ? 0 : 1;
    return pages.sort((a, b) => main(a) - main(b));
}

export interface Connection {
    send: Send;
    close(): void;
}

/** Opens a page target's websocket */
export async function open(url: string, timeoutMs = 20_000): Promise<Connection> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new CdpError(`Couldn't open ${url}`)), { once: true });
    });

    let next = 1;
    const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout>; }>();
    ws.addEventListener("message", event => {
        let message: { id?: number; result?: unknown; error?: { message: string; }; };
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.id === undefined) return;
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new CdpError(message.error.message));
        else waiter.resolve(message.result);
    });
    ws.addEventListener("close", () => {
        for (const waiter of pending.values()) waiter.reject(new CdpError("The page closed the connection"));
        pending.clear();
    });

    return {
        send: (method, params = {}) => new Promise((resolve, reject) => {
            const id = next++;
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new CdpError(`${method} timed out after ${timeoutMs} ms`));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            ws.send(JSON.stringify({ id, method, params }));
        }),
        close: () => ws.close(),
    };
}

/** Connects to the Discord page that runs Evi */
export async function connect(port: number, timeoutMs = 20_000): Promise<Connection> {
    let targets: Target[];
    try {
        targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json() as Target[];
    } catch {
        throw new CdpError(`Nothing answers on 127.0.0.1:${port}. Start Discord with --remote-debugging-port=${port} (mist restart).`);
    }
    const pages = discordPages(targets);
    for (const page of pages) {
        const connection = await open(page.webSocketDebuggerUrl!, timeoutMs).catch(() => null);
        if (!connection) continue;
        if (await evaluate(connection.send, `typeof Evi === "object"`).catch(() => false)) return connection;
        connection.close();
    }
    throw new CdpError(`None of the ${pages.length} Discord pages on port ${port} runs Evi`);
}
