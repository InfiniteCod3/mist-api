/** The Chrome DevTools Protocol side of the CLI. Each function takes a `send`; tests/cdp.test.ts passes one over node:inspector. */

export type Send = (method: string, params?: Record<string, unknown>) => Promise<any>;
/** Calls `handler` with the params of each `method` event the page sends; returns the unsubscribe */
export type Listen = (method: string, handler: (params: any) => void) => () => void;

export interface RemoteObject { type: string; subtype?: string; value?: unknown; unserializableValue?: string; objectId?: string; description?: string; }
interface Evaluated { result: RemoteObject; exceptionDetails?: { text?: string; exception?: RemoteObject; }; }

/** An error the CLI prints as its message alone, then exits with 1 */
export class CliError extends Error { }

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A key for a watch the CLI keeps in the page, unique across CLIs reading the same page */
export const watchId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function unwrap(answer: Evaluated): RemoteObject {
    if (answer.exceptionDetails) {
        const { exception, text } = answer.exceptionDetails;
        throw new CliError(exception?.description ?? text ?? "Evaluation failed");
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
    if (!handle) throw new CliError(`${plugin} isn't a mist-api plugin on this page (mist status lists them)`);
    const { privateProperties = [] }: Properties = await send("Runtime.getProperties", { objectId: handle, ownProperties: true });
    const id = privateProperties.length === 1 ? privateProperties[0].value?.objectId : undefined;
    if (!id) {
        const version = await callOn<unknown>(send, handle, "function () { return this.mistVersion; }").catch(() => "unknown");
        throw new CliError(`${plugin}'s handle holds no debug capability this CLI can read (it has ${privateProperties.length} private fields, mist-api ${version}). Rebuild the plugin with this mist-api.`);
    }
    return id;
}

const releaseGroup = (send: Send, group: string) => send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => { });

/** Calls `fn` on the plugin's capability, which is `this` inside it, and releases the capability after */
export async function callCapability<T>(send: Send, plugin: string, fn: string, args: unknown[] = []): Promise<T> {
    const group = `mist-cli-${watchId()}`;
    try {
        return await callOn<T>(send, await capability(send, plugin, group), fn, args);
    } finally {
        await releaseGroup(send, group);
    }
}

/**
 * Why the registry says not to trust the plugin's handle, read from the registry itself rather than
 * window.Mist. null when the registry keeps no history. A handle that says its plugin is stopped
 * gets a concern too: the plugin's real capability refuses calls then, and only a stand-in takes one.
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

interface Target { type: string; url: string; title: string; webSocketDebuggerUrl?: string; }

/** Discord pages among the debugging port's targets, the main app first */
function discordPages(targets: Target[]): Target[] {
    const pages = targets.filter(target => target.type === "page" && target.webSocketDebuggerUrl && /^https:\/\/(?:\w+\.)?discord\.com\//.test(target.url));
    const main = (target: Target) => /^https:\/\/(?:\w+\.)?discord\.com\/(?:app|channels)\b/.test(target.url) ? 0 : 1;
    return pages.sort((a, b) => main(a) - main(b));
}

export interface Connection {
    send: Send;
    on: Listen;
    close(): void;
}

function handshake(ws: WebSocket, url: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new CliError(`${url} didn't finish opening within ${timeoutMs} ms`));
            ws.close();
        }, timeoutMs);
        ws.addEventListener("open", () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
        ws.addEventListener("error", () => {
            clearTimeout(timer);
            reject(new CliError(`Couldn't open ${url}`));
        }, { once: true });
    });
}

interface Message { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string; }; }

/** Opens a page target's websocket; `timeoutMs` bounds the handshake and each command */
export async function open(url: string, timeoutMs = 20_000): Promise<Connection> {
    const ws = new WebSocket(url);
    await handshake(ws, url, timeoutMs);

    let next = 1;
    const handlers = new Map<string, Set<(params: any) => void>>();
    const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout>; }>();
    ws.addEventListener("message", event => {
        let message: Message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.id === undefined) {
            for (const handler of message.method ? handlers.get(message.method) ?? [] : []) {
                try {
                    handler(message.params);
                } catch (err) {
                    console.error(`mist: a ${message.method} listener threw:`, err);
                }
            }
            return;
        }
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new CliError(message.error.message));
        else waiter.resolve(message.result);
    });
    ws.addEventListener("close", () => {
        for (const waiter of pending.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(new CliError("The page closed the connection"));
        }
        pending.clear();
    });

    return {
        send: (method, params = {}) => new Promise((resolve, reject) => {
            if (ws.readyState !== WebSocket.OPEN) return reject(new CliError(`${method} wasn't sent: the connection to the page is closed`));
            const id = next++;
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new CliError(`${method} timed out after ${timeoutMs} ms`));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            ws.send(JSON.stringify({ id, method, params }));
        }),
        on: (method, handler) => {
            let set = handlers.get(method);
            if (!set) handlers.set(method, set = new Set());
            set.add(handler);
            return () => void set.delete(handler);
        },
        close: () => ws.close(),
    };
}

/** Connects to the Discord page that runs Evi */
export async function connect(port: number, timeoutMs = 20_000): Promise<Connection> {
    let targets: Target[];
    try {
        targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json() as Target[];
    } catch {
        throw new CliError(`Nothing answers on 127.0.0.1:${port}. Start Discord with --remote-debugging-port=${port} (mist restart).`);
    }
    const pages = discordPages(targets);
    for (const page of pages) {
        const connection = await open(page.webSocketDebuggerUrl!, timeoutMs).catch(() => null);
        if (!connection) continue;
        if (await evaluate(connection.send, `typeof Evi === "object"`).catch(() => false)) return connection;
        connection.close();
    }
    throw new CliError(`None of the ${pages.length} Discord pages on port ${port} runs Evi`);
}
