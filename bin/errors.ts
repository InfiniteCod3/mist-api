/**
 * mist errors: console errors, uncaught exceptions and the page's error log entries, read over
 * CDP, attributed to a plugin where the message or the stack says which, with plugin frames mapped
 * through the inline source map of a watch build.
 */
import { callOn, CliError, evaluate, type Listen, type RemoteObject, type Send, sleep } from "./cdp.ts";
import { errorText } from "./format.ts";
import { type Limits, pageSnapshot } from "./page.ts";
import { type Mapper, mapper, parseDataUrl, type Position } from "./sourcemap.ts";

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

/** The params of Runtime.consoleAPICalled, Runtime.exceptionThrown and Log.entryAdded, as far as mist reads them */
interface EventParams {
    type?: string;
    timestamp?: number;
    args?: RemoteObject[];
    stackTrace?: StackTrace;
    exceptionDetails?: { text?: string; exception?: RemoteObject; stackTrace?: StackTrace; };
    entry?: { level?: string; source?: string; text?: string; url?: string; timestamp?: number; stackTrace?: StackTrace; };
}

/** The console methods whose calls count as errors */
const ERROR_TYPES = new Set(["error", "assert"]);

function rawEvent(method: string, params: EventParams): Raw | null {
    switch (method) {
        case "Runtime.consoleAPICalled":
            return ERROR_TYPES.has(params.type ?? "") ? { at: params.timestamp ?? 0, source: "console", args: params.args ?? [], text: "", stack: params.stackTrace } : null;
        case "Runtime.exceptionThrown": {
            const details = params.exceptionDetails ?? {};
            return { at: params.timestamp ?? 0, source: "exception", args: details.exception ? [details.exception] : [], text: details.exception ? "" : details.text ?? "Uncaught", stack: details.stackTrace };
        }
        case "Log.entryAdded": {
            const entry = params.entry ?? {};
            if (entry.level !== "error") return null;
            return { at: entry.timestamp ?? 0, source: "log", args: [], text: scrubUrls(`${entry.source}: ${entry.text}${entry.url ? ` (${entry.url})` : ""}`), stack: entry.stackTrace };
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
const scrubUrls =(text: string) => text.replace(/\b[a-z][\w+.-]*:\/\/[^\s"'<>()]+/gi, scrubUrl);

/** `    at fn (url:line:col)` and `    at url:line:col` lines of a V8 stack */
export function parseStack(text: string): Omit<Frame, "original">[] {
    const frames: Omit<Frame, "original">[] = [];
    for (const line of text.split("\n")) {
        const match = /^\s*at (?:(.*?) \()?((?:[a-z][\w+.-]*:\/\/|\/)[^\s()]*?):(\d+):(\d+)\)?\s*$/.exec(line);
        if (match) frames.push({ fn: match[1] ?? "", url: match[2], line: Number(match[3]), column: Number(match[4]) });
    }
    return frames;
}

/** Evi's Logger prints `%c Evi %c <name> ` and two styles before its arguments */
const EVI_PREFIX = /^%c Evi %c (.*?) ?$/;

/** Splits Evi's logger name off a console call's arguments, and drops the style arguments of any other %c */
export function formatArgs(args: RemoteObject[]): { logger: string | null; args: RemoteObject[]; } {
    const format = args[0]?.type === "string" ? String(args[0].value) : "";
    const prefix = EVI_PREFIX.exec(format);
    if (prefix) return { logger: prefix[1], args: args.slice(3) };
    if (!format.includes("%c")) return { logger: null, args };
    // Each %c takes a style argument and prints nothing
    const styles = format.split("%c").length - 1;
    return { logger: null, args: [{ type: "string", value: format.replaceAll("%c", "").trim() }, ...args.slice(1 + styles)] };
}

/** One argument as text; objects are copied through pageSnapshot, which masks fields named like secrets */
async function show(send: Send, arg: RemoteObject, limits: Limits): Promise<string> {
    if (arg.type === "string") return String(arg.value);
    if (arg.type === "undefined") return "undefined";
    if (arg.unserializableValue) return arg.unserializableValue;
    if (arg.subtype === "error" || !arg.objectId) return arg.description ?? JSON.stringify(arg.value) ?? String(arg.value);
    const copy = await callOn(send, arg.objectId, `function (limits) { return (${pageSnapshot})(this, limits); }`, [limits]).catch(() => arg.description);
    return typeof copy === "string" ? copy : JSON.stringify(copy);
}

/**
 * Who an Evi log line is about. Each pattern is one of Evi's messages for an error it caught and
 * logged instead of throwing (src/renderer/patching/hooks.ts, plugins/manager.ts, webpack/runtime.ts).
 */
function loggerPlugins(logger: string, message: string, byName: Map<string, string>): string[] {
    const named = byName.get(logger);
    if (named) return [named];
    const id = (name: string) => byName.get(name) ?? name;
    switch (logger) {
        case "Hooks": {
            const hooked = /^(?:before|after|instead) hook of (\S+) on /.exec(message)?.[1];
            return hooked && hooked !== "unknown" ? [hooked] : [];
        }
        case "Plugins": {
            const failed = (/^Failed to (?:start|reload|evaluate) (.+)$/.exec(message) ?? /^(.+) threw while stopping$/.exec(message))?.[1];
            return failed ? [id(failed)] : [];
        }
        case "Webpack": {
            const patchers = /^Module \S+ threw\. It was patched by: (.+)$/.exec(message)?.[1];
            return patchers ? patchers.split(", ") : [];
        }
    }
    return [];
}

const pluginOfUrl = (url: string) => /^evi:\/\/plugins\/(.+)\.js$/.exec(url)?.[1];
const moduleOfUrl = (url: string) => /^evi:\/\/modules\/(.+)\.js$/.exec(url)?.[1];

/** Evi evaluates a plugin as `new Function(…, "return function (module, exports, require) {" + code …)` */
const EVI_WRAPPER = "return function (module, exports, require) {";

/** Where the bundle starts in the script Evi made of it: the map's positions count from there */
export function codeOffset(source: string): { line: number; column: number; } {
    const at = source.indexOf(EVI_WRAPPER);
    if (at < 0) return { line: 0, column: 0 };
    const start = at + EVI_WRAPPER.length;
    const before = source.slice(0, start);
    const line = before.split("\n").length - 1;
    return { line, column: start - (before.lastIndexOf("\n") + 1) };
}

/** The last inline map a script names; Evi's wrapper puts the bundle's sourceMappingURL comment inside a function, where V8 still finds it */
function inlineMapUrl(source: string): string | null {
    const all = [...source.matchAll(/\/\/[#@] sourceMappingURL=(data:\S+)/g)];
    return all.length ? all[all.length - 1][1] : null;
}

interface ScriptMapper { map: Mapper; offset: { line: number; column: number; }; }

/** The scripts the debugger parsed, kept by id because a hot reload compiles a new script at the same URL */
class ScriptMaps {
    readonly #send: Send;
    readonly #mapUrls = new Map<string, string>();
    readonly #idsByUrl = new Map<string, string[]>();
    readonly #mappers = new Map<string, Promise<ScriptMapper | null>>();

    constructor(send: Send) {
        this.#send = send;
    }

    scriptParsed(scriptId: string, url: string, sourceMapURL: string | undefined): void {
        this.#mapUrls.set(scriptId, sourceMapURL ?? "");
        const ids = this.#idsByUrl.get(url);
        if (ids) ids.push(scriptId);
        else this.#idsByUrl.set(url, [scriptId]);
    }

    mapperOf(scriptId: string): Promise<ScriptMapper | null> {
        const mapUrl = this.#mapUrls.get(scriptId);
        if (mapUrl === undefined) return Promise.resolve(null);
        let found = this.#mappers.get(scriptId);
        if (!found) this.#mappers.set(scriptId, found = this.#send("Debugger.getScriptSource", { scriptId }).then(
            ({ scriptSource }: { scriptSource: string; }) => scriptSource,
            () => "",
        ).then(scriptSource => {
            const map = parseDataUrl(mapUrl) ?? parseDataUrl(inlineMapUrl(scriptSource) ?? "");
            return map ? { map: mapper(map), offset: codeOffset(scriptSource) } : null;
        }));
        return found;
    }

    async mapFrame({ scriptId, ...frame }: RawFrame): Promise<Frame> {
        const shown = { ...frame, url: scrubUrl(frame.url) };
        const ids = this.#idsByUrl.get(frame.url);
        // A frame read from a stack's text can't say which of several builds at its URL it ran in
        const id = scriptId ?? (ids?.length === 1 ? ids[0] : undefined);
        if (!pluginOfUrl(frame.url) || id === undefined) return { ...shown, original: null };
        const found = await this.mapperOf(id);
        if (!found) return { ...shown, original: null };
        const line = frame.line - 1 - found.offset.line;
        const column = frame.column - 1 - (line === 0 ? found.offset.column : 0);
        const at = line >= 0 && column >= 0 ? found.map(line, column) : null;
        return { ...shown, original: at && { ...at, line: at.line + 1, column: at.column + 1 } };
    }
}

/** Says which plugins an error belongs to, from Evi's plugin names and patch diagnosis, read from the page as needed */
class Attributor {
    readonly #send: Send;
    readonly #byName = new Map<string, string>();
    readonly #unknownLoggers = new Set<string>();
    #patchers: Promise<Map<string, string[]>> | null = null;

    constructor(send: Send) {
        this.#send = send;
    }

    async refreshNames(): Promise<void> {
        const list = await evaluate<[string, string][]>(this.#send, `(globalThis.Evi?.plugins?.getSnapshot?.() ?? []).map(s => [s.manifest.id, s.manifest.name])`).catch(() => []);
        for (const [id, name] of list) {
            this.#byName.set(name, id);
            this.#byName.set(id, id);
        }
    }

    /** Whether `logger` is a plugin's logger, rather than one of Evi's */
    isPlugin(logger: string): boolean {
        return this.#byName.has(logger);
    }

    /** Evi compiled a module again: which plugins patch which modules may have changed */
    modulesChanged(): void {
        this.#patchers = null;
    }

    /** A logger the page names before refreshing gets one more look at the plugin list */
    async loggerPlugins(logger: string, message: string): Promise<string[]> {
        if (!this.#byName.has(logger) && !this.#unknownLoggers.has(logger)) {
            this.#unknownLoggers.add(logger);
            await this.refreshNames();
        }
        return loggerPlugins(logger, message, this.#byName);
    }

    async patchersOf(moduleId: string): Promise<string[]> {
        this.#patchers ??= evaluate<[string, string[]][]>(this.#send, `(() => {
            const out = {};
            for (const diagnosis of globalThis.Evi?.diagnosePatches?.() ?? []) for (const module of diagnosis.modules) (out[module] ??= new Set()).add(diagnosis.plugin);
            return Object.entries(out).map(([module, plugins]) => [module, [...plugins]]);
        })()`).catch(() => []).then(entries => new Map(entries));
        return (await this.#patchers).get(moduleId) ?? [];
    }

    /** By Evi's logger first, then the first plugin frame, then the plugins that patched the module that threw */
    async attribute(logger: string | null, message: string, frames: RawFrame[]): Promise<{ plugins: string[]; via: Attribution | null; }> {
        if (logger !== null) {
            const plugins = await this.loggerPlugins(logger, message);
            if (plugins.length) return { plugins, via: "logger" };
        }
        const plugin = frames.map(frame => pluginOfUrl(frame.url)).find(Boolean);
        if (plugin) return { plugins: [plugin], via: "stack" };
        const module = frames.map(frame => moduleOfUrl(frame.url)).find(Boolean);
        const plugins = module ? await this.patchersOf(module) : [];
        return plugins.length ? { plugins, via: "patched module" } : { plugins: [], via: null };
    }
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
        throw new CliError(`mist didn't turn on Discord's debugger: it couldn't make it skip pauses first (${errorText(err)}), and a pause would freeze Discord`);
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
 * pageSnapshot, which masks fields named like secrets. Turns its domains off again however it ends.
 */
export async function watchErrors(send: Send, listen: Listen, options: ErrorOptions, onRecord: (record: ErrorRecord) => void): Promise<void> {
    const { follow, stopped = () => false, limits, settleMs = 300, pollMs = 250, onReplayed = () => { } } = options;
    const scripts = new ScriptMaps(send);
    const attributor = new Attributor(send);
    const queue: Raw[] = [];
    const off = [
        listen("Debugger.scriptParsed", (p: { scriptId: string; url: string; sourceMapURL?: string; }) => {
            if (!p.url) return;
            scripts.scriptParsed(p.scriptId, p.url, p.sourceMapURL);
            if (moduleOfUrl(p.url)) attributor.modulesChanged();
        }),
        ...["Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded"].map(method => listen(method, params => {
            const raw = rawEvent(method, params);
            if (raw) queue.push(raw);
        })),
    ];

    const record = async (raw: Raw): Promise<ErrorRecord> => {
        const { logger, args } = formatArgs(raw.args);
        const parts = await Promise.all(args.map(arg => show(send, arg, limits)));
        const text = [raw.text, ...parts].filter(Boolean).join(" ");
        const stackText = args.filter(arg => arg.subtype === "error").map(arg => arg.description ?? "").join("\n");
        const frames: RawFrame[] = parseStack(stackText);
        if (!frames.length) {
            for (const frame of raw.stack?.callFrames ?? []) frames.push({ fn: frame.functionName, scriptId: frame.scriptId, url: frame.url, line: frame.lineNumber + 1, column: frame.columnNumber + 1 });
        }
        const { plugins, via } = await attributor.attribute(logger, parts[0] ?? "", frames);
        const loggerTag = logger !== null && !attributor.isPlugin(logger) ? `[${logger}] ` : "";
        return { at: Math.floor(raw.at), source: raw.source, text: scrubUrls(loggerTag + text), plugins, via, frames: await Promise.all(frames.slice(0, 8).map(frame => scripts.mapFrame(frame))) };
    };

    const drain = async () => {
        while (queue.length) onRecord(await record(queue.shift()!));
    };

    let stopDebugger = () => { };
    try {
        await attributor.refreshNames();
        stopDebugger = await enableDebugger(send, listen);
        await send("Runtime.enable");
        await send("Log.enable").catch(() => { });
        await sleep(settleMs);
        await drain();
        onReplayed();
        while (follow && !stopped()) {
            await sleep(pollMs);
            await drain();
        }
    } finally {
        for (const stop of off) stop();
        stopDebugger();
        for (const method of ["Log.disable", "Runtime.disable", "Debugger.disable"]) await send(method).catch(() => { });
    }
}

const place = (frame: Frame) => frame.original
    ? `${frame.original.source}:${frame.original.line}:${frame.original.column}`
    : `${frame.url}:${frame.line}:${frame.column}`;

const frameLine = (frame: Frame) => {
    const name = frame.original?.name || frame.fn;
    return `    at ${name ? `${name} ` : ""}(${place(frame)})`;
};

export function errorLines(record: ErrorRecord, time: (at: number) => string, frames = 4): string[] {
    const who = record.plugins.length ? ` [${record.plugins.join(", ")}]` : "";
    const [first, ...rest] = record.text.split("\n").filter(line => !/^\s*at /.test(line));
    return [
        `${time(record.at)} ${record.source.padEnd(9)}${who} ${first ?? ""}`,
        ...rest.map(line => `    ${line}`),
        ...record.frames.slice(0, frames).map(frameLine),
    ];
}
