import { find } from "@evi/api";

import { isRecord, sleep } from "../util.ts";
import { checkApiRequest, need } from "./permissions.ts";

type Method = "get" | "post" | "put" | "patch" | "del";

/** What Discord's API client resolves with, and rejects with for a status outside 2xx */
interface ClientResponse {
    status?: unknown;
    body?: unknown;
    retryAfter?: unknown;
}

interface ClientRequest {
    url: string;
    query?: RestOptions["query"];
    body?: unknown;
    headers?: Record<string, string>;
    reason?: string;
    signal?: AbortSignal;
    rejectWithError: false;
}

type DiscordClient = Record<Method, (request: ClientRequest) => Promise<ClientResponse>>;

const METHODS: readonly Method[] = ["get", "post", "put", "patch", "del"];

/** Discord's own client has the five methods. The superagent under it has them too, plus getXHR and Request. */
export const isDiscordClient = (value: unknown): value is DiscordClient =>
    (typeof value === "object" || typeof value === "function") && value !== null
    && METHODS.every(m => typeof (value as Record<string, unknown>)[m] === "function")
    && !("getXHR" in value) && !("Request" in value);

// The object, not its methods: a plugin that hooks one replaces it on this object, and the hook still runs
let client: DiscordClient | undefined;

function discordClient(): DiscordClient {
    client ??= find<DiscordClient>(isDiscordClient);
    if (!client) throw new Error("Discord's API client isn't available");
    return client;
}

export interface RestOptions {
    /** Added to the URL. A null or undefined value is left out. */
    query?: Record<string, string | number | boolean | null | undefined>;
    /** Sent as JSON */
    body?: unknown;
    headers?: Record<string, string>;
    /** The audit log reason, for actions in a server */
    reason?: string;
    signal?: AbortSignal;
}

/** An answer from Discord's API outside 2xx, or no answer at all (`status` 0) */
export class DiscordApiError extends Error {
    /** The HTTP status, or 0 when the request got no answer */
    readonly status: number;
    /** Discord's JSON error code, as in 50001 for Missing Access */
    readonly code: number | undefined;
    /** For a 429: how many seconds to wait before asking again */
    readonly retryAfter: number | undefined;
    /** The answer's parsed body */
    readonly body: unknown;
    readonly method: string;
    readonly path: string;

    constructor(init: { method: string; path: string; status: number; code?: number; retryAfter?: number; body?: unknown; detail?: string; cause?: unknown; }) {
        const { method, path, status, code, retryAfter, body, detail } = init;
        super(`${method} ${path}: ${status || "no answer"}${detail ? ` ${detail}` : ""}${code !== undefined ? ` (code ${code})` : ""}`, { cause: init.cause });
        this.name = "DiscordApiError";
        this.status = status;
        this.code = code;
        this.retryAfter = retryAfter;
        this.body = body;
        this.method = method;
        this.path = path;
    }
}

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

const verbOf = (method: Method) => method === "del" ? "DELETE" : method.toUpperCase();

export function toApiError(method: Method, path: string, failure: unknown): DiscordApiError {
    const verb = verbOf(method);
    if (!isRecord(failure) || typeof failure.status !== "number") {
        return new DiscordApiError({ method: verb, path, status: 0, detail: failure instanceof Error ? failure.message : String(failure), cause: failure });
    }
    const body = failure.body;
    const fields = isRecord(body) ? body : {};
    return new DiscordApiError({
        method: verb,
        path,
        status: failure.status,
        code: finite(fields.code),
        retryAfter: finite(failure.retryAfter) ?? finite(fields.retry_after),
        body,
        detail: typeof fields.message === "string" ? fields.message : undefined,
    });
}

async function request(plugin: string, method: Method, path: string, options: RestOptions = {}): Promise<unknown> {
    // Discord's client signs any URL it's given: an absolute one would carry the login elsewhere
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
        throw new TypeError(`A Discord API path starts with one /, as in "/users/@me", got ${JSON.stringify(path)}`);
    }
    checkApiRequest(plugin, verbOf(method), path);
    const { query, body, headers, reason, signal } = options;
    signal?.throwIfAborted();
    try {
        const answer = await discordClient()[method]({ url: path, query, body, headers, reason, signal, rejectWithError: false });
        return answer?.body;
    } catch (failure) {
        signal?.throwIfAborted();
        throw toApiError(method, path, failure);
    }
}

export type Rest = Record<Method, (path: string, options?: RestOptions) => Promise<unknown>>;

export const restFor = (plugin: string): Rest => ({
    get: (path, options) => request(plugin, "get", path, options),
    post: (path, options) => request(plugin, "post", path, options),
    put: (path, options) => request(plugin, "put", path, options),
    patch: (path, options) => request(plugin, "patch", path, options),
    del: (path, options) => request(plugin, "del", path, options),
});

/** A message as Discord's API gives it. The fields listed are checked; the rest are as Discord sent them. */
export interface ApiMessage {
    id: string;
    channel_id: string;
    content: string;
    /** ISO 8601 */
    timestamp: string;
    author: { id: string; username: string; [field: string]: unknown; };
    [field: string]: unknown;
}

const isSnowflake = (value: unknown): value is string => typeof value === "string" && /^\d{1,20}$/.test(value);

const isMessage = (value: unknown): value is ApiMessage =>
    isRecord(value) && isSnowflake(value.id) && isSnowflake(value.channel_id)
    && typeof value.content === "string" && typeof value.timestamp === "string"
    && isRecord(value.author) && isSnowflake(value.author.id) && typeof value.author.username === "string";

const byId = (a: { id: string; }, b: { id: string; }) => {
    const x = BigInt(a.id), y = BigInt(b.id);
    return x < y ? -1 : x > y ? 1 : 0;
};

export type MessagesOptions = ({ before?: string; after?: undefined; } | { after: string; before?: undefined; }) & {
    /** How many messages in all. Default: every one there is. */
    limit?: number;
    signal?: AbortSignal;
};

/** Discord's most per request */
const PAGE = 100;
/** 429s in a row on one page before giving up */
const RATE_LIMIT_TRIES = 5;

async function page(plugin: string, channelId: string, query: Record<string, string | number>, signal: AbortSignal | undefined): Promise<unknown[]> {
    for (let tries = 1; ; tries++) {
        try {
            const body = await request(plugin, "get", `/channels/${channelId}/messages`, { query, signal });
            return Array.isArray(body) ? body : [];
        } catch (err) {
            if (!(err instanceof DiscordApiError) || err.status !== 429 || tries >= RATE_LIMIT_TRIES) throw err;
            await sleep(Math.max(err.retryAfter ?? 1, 0.05) * 1000, signal);
        }
    }
}

/**
 * The channel's messages, a page at a time. Newest first from the latest, or from before `before`;
 * oldest first from after `after`. A 429 waits as long as Discord says, then asks again.
 */
export async function* messages(plugin: string, channelId: string, options: MessagesOptions = {}): AsyncGenerator<ApiMessage, void, undefined> {
    if (!isSnowflake(channelId)) throw new TypeError(`A channel id is a Discord id, got ${JSON.stringify(channelId)}`);
    need(plugin, "readMessages", `/channels/${channelId}/messages`);
    const { before, after, signal, limit = Infinity } = options;
    if (before !== undefined && after !== undefined) throw new TypeError("Page from before or from after, not both");
    const forward = after !== undefined;
    let cursor = forward ? after : before;
    if (cursor !== undefined && !isSnowflake(cursor)) throw new TypeError(`A message id is a Discord id, got ${JSON.stringify(cursor)}`);
    let left = Math.max(0, Math.floor(limit));
    while (left > 0) {
        signal?.throwIfAborted();
        const size = Math.min(PAGE, left);
        const raw = await page(plugin, channelId, cursor === undefined ? { limit: size } : { limit: size, [forward ? "after" : "before"]: cursor }, signal);
        const found = raw.filter(isMessage).sort(byId);
        if (!forward) found.reverse();
        for (const message of found) {
            if (left-- <= 0) return;
            yield message;
        }
        if (raw.length < size || !found.length) return;
        cursor = found.at(-1)!.id;
    }
}
