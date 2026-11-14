/** One server-sent event */
export interface SseEvent {
    /** The event's `event:` field, or "message" when it had none */
    event: string;
    /** Its `data:` lines, joined with "\n" */
    data: string;
    /** Its `id:` field, when it had one */
    id?: string;
}

// A CR at the very end may be the first half of a CRLF still on its way
const LINE = /\r\n|\n|\r(?!$)/g;

/**
 * Reads the complete events at the start of `buffer`, text of the SSE format (text/event-stream).
 * `rest` is the text after the last complete event: put the next chunk after it and parse again.
 * Comments, `retry:` and unknown fields are skipped, and an event without data is dropped, as
 * browsers' EventSource does.
 */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string; } {
    const events: SseEvent[] = [];
    let data: string[] = [], event = "", id: string | undefined;
    let start = 0, consumed = 0;
    LINE.lastIndex = 0;
    for (let match = LINE.exec(buffer); match; match = LINE.exec(buffer)) {
        const line = buffer.slice(start, match.index);
        start = LINE.lastIndex;
        if (!line) {
            if (data.length) events.push({ event: event || "message", data: data.join("\n"), ...id !== undefined && { id } });
            data = [];
            event = "";
            id = undefined;
            consumed = start;
            continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + (line[colon + 1] === " " ? 2 : 1));
        if (field === "data") data.push(value);
        else if (field === "event") event = value;
        else if (field === "id" && !value.includes("\0")) id = value;
    }
    return { events, rest: buffer.slice(consumed) };
}

/**
 * The events of a server-sent event stream, as they arrive: a fetch `Response` or its body. Ends with
 * the stream; an event the stream ends in the middle of is dropped. The stream is cancelled when the
 * loop stops early (break, return or throw) and when `signal` aborts, which throws the signal's reason.
 */
export async function* sseEvents(source: Response | ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent, void, undefined> {
    const stream = "getReader" in source ? source : source.body;
    if (!stream) return;
    if (signal?.aborted) {
        await stream.cancel(signal.reason).catch(() => { });
        throw signal.reason;
    }
    const reader = stream.getReader();
    const onAbort = () => void reader.cancel(signal!.reason).catch(() => { });
    signal?.addEventListener("abort", onAbort, { once: true });
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        for (; ;) {
            const { done, value } = await reader.read();
            if (signal?.aborted) throw signal.reason;
            const text = done ? buffer + decoder.decode() : buffer + decoder.decode(value, { stream: true });
            const { events, rest } = parseSse(done && text.endsWith("\r") ? `${text}\n` : text);
            buffer = rest;
            for (const event of events) yield event;
            if (done) return;
        }
    } finally {
        signal?.removeEventListener("abort", onAbort);
        await reader.cancel().catch(() => { });
    }
}
