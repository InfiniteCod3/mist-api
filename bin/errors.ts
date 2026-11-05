/**
 * mist errors: console errors, uncaught exceptions and the page's own error log entries, read over
 * CDP, attributed to a plugin where the message or the stack says which, with plugin frames mapped
 * through the inline source map of a watch build.
 */
import { callOn, CdpError, evaluate, type Listen, type Send } from "./cdp.ts";
import { type Limits, pageSnapshot } from "./page.ts";
import { type Mapper, mapper, parseDataUrl, type Position } from "./sourcemap.ts";

interface RemoteObject { type: string; subtype?: string; value?: unknown; unserializableValue?: string; objectId?: string; description?: string; }
interface CallFrame { functionName: string; scriptId?: string; url: string; lineNumber: number; columnNumber: number; }
interface StackTrace { callFrames: CallFrame[]; }

/** A stack frame, 1-based as a stack prints it, with where it came from in the plugin's source when its map says */
export interface Frame { fn: string; url: string; line: number; column: number; original: Position | null; }
/** A frame before mapping; CDP's frames name the script they ran in, frames read from a stack's text don't */
type RawFrame = Omit<Frame, "original"> & { scriptId?: string; };
export type ErrorSource = "console" | "exception" | "log";
export type Attribution = "logger" | "stack" | "patched module";
export interface ErrorRecord {
    at: number;
    source: ErrorSource;
    text: string;
    /** Plugin ids the error belongs to; several when a module that many patched threw */
    plugins: string[];
    via: Attribution | null;
    frames: Frame[];
}

/** One event as the page sent it, before its values are read */
interface Raw { at: number; source: ErrorSource; args: RemoteObject[]; text: string; stack: StackTrace | undefined; }

/** The console methods whose calls count as errors */
const ERROR_TYPES = new Set(["error", "assert"]);

export function rawEvent(method: string, params: any): Raw | null {
    switch (method) {
        case "Runtime.consoleAPICalled":
            return ERROR_TYPES.has(params.type) ? { at: params.timestamp, source: "console", args: params.args ?? [], text: "", stack: params.stackTrace } : null;
        case "Runtime.exceptionThrown": {
            const d = params.exceptionDetails ?? {};
            return { at: params.timestamp, source: "exception", args: d.exception ? [d.exception] : [], text: d.exception ? "" : d.text ?? "Uncaught", stack: d.stackTrace };
        }
        case "Log.entryAdded": {
            const e = params.entry ?? {};
            return e.level === "error" ? { at: e.timestamp, source: "log", args: [], text: scrubUrls(`${e.source}: ${e.text}${e.url ? ` (${e.url})` : ""}`), stack: e.stackTrace } : null;
        }
    }
    return null;
}

/** A query string or fragment can carry a token, and a webhook URL's segment after its id is one */
function scrubUrl(url: string): string {
    const [, base, position = ""] = /^(.*?)((?::\d+){1,2})?$/.exec(url)!;
    return base.replace(/(\/webhooks\/\d+\/)[^/?#]+/, "$1[secret]").replace(/[?#].*/, "") + position;
}

/** Every URL in the text, scrubbed */
export const scrubUrls = (text: string) => text.replace(/\b[a-z][\w+.-]*:\/\/[^\s"'<>()]+/gi, scrubUrl);

/** `    at fn (url:line:col)` and `    at url:line:col` lines of a V8 stack */
export function parseStack(text: string): Omit<Frame, "original">[] {
    const frames: Omit<Frame, "original">[] = [];
    for (const line of text.split("\n")) {
        const m = /^\s*at (?:(.*?) \()?((?:[a-z][\w+.-]*:\/\/|\/)[^\s()]*?):(\d+):(\d+)\)?\s*$/.exec(line);
        if (m) frames.push({ fn: m[1] ?? "", url: m[2], line: Number(m[3]), column: Number(m[4]) });
    }
    return frames;
}

/** Evi's Logger prints `%c Evi %c <name> ` and two styles before its arguments */
const EVI_PREFIX = /^%c Evi %c (.*?) ?$/;

/**
 * Who an Evi log line is about. Each pattern is one of Evi's messages for an error it caught and
 * logged instead of throwing (src/renderer/patching/hooks.ts, plugins/manager.ts, webpack/runtime.ts).
 */
export function loggerPlugins(logger: string, message: string, byName: Map<string, string>): string[] {
    const own = byName.get(logger);
    if (own) return [own];
    const id = (name: string) => byName.get(name) ?? name;
    let m: RegExpExecArray | null;
    if (logger === "Hooks" && (m = /^(?:before|after|instead) hook of (\S+) on /.exec(message))) return m[1] === "unknown" ? [] : [m[1]];
    if (logger === "Plugins" && (m = /^Failed to (?:start|reload|evaluate) (.+)$/.exec(message) ?? /^(.+) threw while stopping$/.exec(message))) return [id(m[1])];
    if (logger === "Webpack" && (m = /^Module \S+ threw\. It was patched by: (.+)$/.exec(message))) return m[1].split(", ");
    return [];
}

const pluginOfUrl = (url: string) => /^evi:\/\/plugins\/(.+)\.js$/.exec(url)?.[1];
const moduleOfUrl = (url: string) => /^evi:\/\/modules\/(.+)\.js$/.exec(url)?.[1];

/** Evi evaluates a plugin as `new Function(…, "return function (module, exports, require) {" + code …)` */
const EVI_WRAPPER = "return function (module, exports, require) {";

/** Where the bundle starts in the script Evi made of it, so the map's positions line up */
export function codeOffset(source: string): { line: number; column: number; } {
    const at = source.indexOf(EVI_WRAPPER);
    if (at < 0) return { line: 0, column: 0 };
    const start = at + EVI_WRAPPER.length;
    const before = source.slice(0, start);
    const line = before.split("\n").length - 1;
    return { line, column: start - (before.lastIndexOf("\n") + 1) };
}

/** The last inline map a script names; Evi's wrapper puts the bundle's own comment inside a function, where V8 still finds it */
export function inlineMapUrl(source: string): string | null {
    const all = [...source.matchAll(/\/\/[#@] sourceMappingURL=(data:\S+)/g)];
    return all.length ? all[all.length - 1][1] : null;
}

/**
 * Turns on CDP's debugger, to read scripts, without ever pausing Discord's page. Skipping pauses
 * before Debugger.enable leaves no moment when a breakpoint or `debugger;` stops the page, and a pause
 * that comes anyway, as when another client turns skipping off, is resumed. Returns the unsubscribe.
 */
export async function enableDebugger(send: Send, listen: Listen): Promise<() => void> {
    try {
        await send("Debugger.setSkipAllPauses", { skip: true });
    } catch (err) {
        throw new CdpError(`mist didn't turn on Discord's debugger: it couldn't make it skip pauses first (${(err as Error).message}), and a pause would freeze Discord`);
    }
    const off = listen("Debugger.paused", () => void send("Debugger.resume").catch(() => { }));
    try {
        await send("Debugger.enable");
    } catch (err) {
        off();
        throw err;
    }
    return off;
}

export interface ErrorOptions {
    /** Keep listening until `stopped` */
    follow: boolean;
    stopped?: () => boolean;
    limits: Limits;
    /** How long the page has to replay what it kept before a non-follow read ends */
    settleMs?: number;
    pollMs?: number;
    /** Called once every error the page kept has gone to `onRecord`, before any new one */
    onReplayed?: () => void;
}

/**
 * Reads the errors the page kept (Runtime.enable and Log.enable replay them), then with `follow`
 * the new ones, passing each to `onRecord` in order. Object arguments are copied through
 * pageSnapshot, so fields named like secrets are masked. Turns its domains off again however it ends.
 */
export async function watchErrors(send: Send, listen: Listen, options: ErrorOptions, onRecord: (record: ErrorRecord) => void): Promise<void> {
    const { follow, stopped = () => false, limits, settleMs = 300, pollMs = 250, onReplayed = () => { } } = options;
    /** A hot reload compiles a new script at the same URL, so scripts are kept by id */
    const mapUrls = new Map<string, string>();
    const idsByUrl = new Map<string, string[]>();
    const queue: Raw[] = [];
    const off = [
        listen("Debugger.scriptParsed", p => {
            if (!p.url) return;
            mapUrls.set(p.scriptId, p.sourceMapURL ?? "");
            (idsByUrl.get(p.url) ?? idsByUrl.set(p.url, []).get(p.url)!).push(p.scriptId);
        }),
        ...["Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded"].map(method => listen(method, params => {
            const raw = rawEvent(method, params);
            if (raw) queue.push(raw);
        })),
    ];

    const byName = new Map<string, string>();
    const unknownLoggers = new Set<string>();
    const refreshNames = async () => {
        const list = await evaluate<[string, string][]>(send, `(globalThis.Evi?.plugins?.getSnapshot?.() ?? []).map(s => [s.manifest.id, s.manifest.name])`).catch(() => []);
        for (const [id, name] of list) {
            byName.set(name, id);
            byName.set(id, id);
        }
    };

    let patchers: Map<string, string[]> | null = null;
    const patchersOf = async (moduleId: string) => {
        patchers ??= new Map(await evaluate<[string, string[]][]>(send, `(() => {
            const out = {};
            for (const p of globalThis.Evi?.diagnosePatches?.() ?? []) for (const m of p.modules) (out[m] ??= new Set()).add(p.plugin);
            return Object.entries(out).map(([m, s]) => [m, [...s]]);
        })()`).catch(() => []));
        return patchers.get(moduleId) ?? [];
    };

    const mappers = new Map<string, Promise<{ map: Mapper; offset: { line: number; column: number; }; } | null>>();
    const mapperOf = (scriptId: string) => {
        const mapUrl = mapUrls.get(scriptId);
        if (mapUrl === undefined) return Promise.resolve(null);
        let found = mappers.get(scriptId);
        if (!found) mappers.set(scriptId, found = (async () => {
            const { scriptSource } = await send("Debugger.getScriptSource", { scriptId }).catch(() => ({ scriptSource: "" }));
            const map = parseDataUrl(mapUrl) ?? parseDataUrl(inlineMapUrl(scriptSource) ?? "");
            return map ? { map: mapper(map), offset: codeOffset(scriptSource) } : null;
        })());
        return found;
    };
    const mapFrame = async ({ scriptId, ...frame }: RawFrame): Promise<Frame> => {
        const shown = { ...frame, url: scrubUrl(frame.url) };
        const ids = idsByUrl.get(frame.url);
        // A frame read from a stack's text can't say which of several builds at its URL it ran in
        const id = scriptId ?? (ids?.length === 1 ? ids[0] : undefined);
        if (!pluginOfUrl(frame.url) || id === undefined) return { ...shown, original: null };
        const found = await mapperOf(id);
        if (!found) return { ...shown, original: null };
        const line = frame.line - 1 - found.offset.line;
        const column = frame.column - 1 - (line === 0 ? found.offset.column : 0);
        const at = line >= 0 && column >= 0 ? found.map(line, column) : null;
        return { ...shown, original: at && { ...at, line: at.line + 1, column: at.column + 1 } };
    };

    const show = async (arg: RemoteObject): Promise<string> => {
        if (arg.type === "string") return String(arg.value);
        if (arg.type === "undefined") return "undefined";
        if (arg.unserializableValue) return arg.unserializableValue;
        if (arg.subtype === "error" || !arg.objectId) return arg.description ?? JSON.stringify(arg.value) ?? String(arg.value);
        const copy = await callOn(send, arg.objectId, `function (limits) { return (${pageSnapshot})(this, limits); }`, [limits]).catch(() => arg.description);
        return typeof copy === "string" ? copy : JSON.stringify(copy);
    };

    const record = async (raw: Raw): Promise<ErrorRecord> => {
        let args = raw.args;
        let logger: string | null = null;
        const format = args[0]?.type === "string" ? String(args[0].value) : "";
        const prefix = EVI_PREFIX.exec(format);
        if (prefix) {
            logger = prefix[1];
            args = args.slice(3);
        } else if (format.includes("%c")) {
            // Each %c takes a style argument and prints nothing
            const styles = format.split("%c").length - 1;
            args = [{ type: "string", value: format.replaceAll("%c", "").trim() }, ...args.slice(1 + styles)];
        }
        const parts = await Promise.all(args.map(show));
        const text = [raw.text, ...parts].filter(Boolean).join(" ");

        const stackText = args.filter(a => a.subtype === "error").map(a => a.description ?? "").join("\n");
        const frames: RawFrame[] = parseStack(stackText);
        if (!frames.length) for (const f of raw.stack?.callFrames ?? []) frames.push({ fn: f.functionName, scriptId: f.scriptId, url: f.url, line: f.lineNumber + 1, column: f.columnNumber + 1 });

        let plugins: string[] = [];
        let via: Attribution | null = null;
        if (logger !== null) {
            if (!byName.has(logger) && !unknownLoggers.has(logger)) {
                unknownLoggers.add(logger);
                await refreshNames();
            }
            plugins = loggerPlugins(logger, parts[0] ?? "", byName);
            if (plugins.length) via = "logger";
        }
        if (!plugins.length) {
            const fromPlugin = frames.map(f => pluginOfUrl(f.url)).find(Boolean);
            if (fromPlugin) [plugins, via] = [[fromPlugin], "stack"];
        }
        if (!plugins.length) {
            const module = frames.map(f => moduleOfUrl(f.url)).find(Boolean);
            if (module) {
                plugins = await patchersOf(module);
                if (plugins.length) via = "patched module";
            }
        }
        const prefixText = logger !== null && !byName.has(logger) ? `[${logger}] ` : "";
        return { at: Math.floor(raw.at), source: raw.source, text: scrubUrls(prefixText + text), plugins, via, frames: await Promise.all(frames.slice(0, 8).map(mapFrame)) };
    };

    const drain = async () => {
        while (queue.length) onRecord(await record(queue.shift()!));
    };

    let stopDebugger = () => { };
    try {
        await refreshNames();
        stopDebugger = await enableDebugger(send, listen);
        await send("Runtime.enable");
        await send("Log.enable").catch(() => { });
        await new Promise(resolve => setTimeout(resolve, settleMs));
        await drain();
        onReplayed();
        while (follow && !stopped()) {
            await new Promise(resolve => setTimeout(resolve, pollMs));
            await drain();
        }
    } finally {
        for (const stop of off) stop();
        stopDebugger();
        for (const method of ["Log.disable", "Runtime.disable", "Debugger.disable"]) await send(method).catch(() => { });
    }
}

const place = (f: Frame) => f.original ? `${f.original.source}:${f.original.line}:${f.original.column}` : `${f.url}:${f.line}:${f.column}`;

export function errorLines(r: ErrorRecord, time: (at: number) => string, frames = 4): string[] {
    const who = r.plugins.length ? ` [${r.plugins.join(", ")}]` : "";
    const [first, ...rest] = r.text.split("\n").filter(line => !/^\s*at /.test(line));
    return [
        `${time(r.at)} ${r.source.padEnd(9)}${who} ${first ?? ""}`,
        ...rest.map(line => `    ${line}`),
        ...r.frames.slice(0, frames).map(f => `    at ${f.original?.name ?? f.fn ?? ""}${f.original?.name || f.fn ? " " : ""}(${place(f)})`),
    ];
}
