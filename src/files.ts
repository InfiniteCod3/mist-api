/** A plugin's data folder under Evi's data folder, and JSON files in it that survive a crash mid-write. */
import type { NativeContext } from "@evi/api/native";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { NativeError } from "./errors.ts";
import { checkDelay, checkNumber, errorMessage, jsonText, shownValue } from "./internal.ts";
import { log } from "./native-log.ts";
import { atQuit } from "./quit.ts";

const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * The plugin's data folder, `<ctx.dataDir>/plugin-data/<plugin id>`, made if missing. `ctx.dataDir`
 * is Evi's data folder, shared by Evi and every plugin. Its `plugins` folder holds installed plugins'
 * code: plugin data stays out of it.
 */
export function dataFolder(ctx: NativeContext): string {
    if (!SAFE_NAME.test(ctx.pluginId)) throw new TypeError(`dataFolder: can't make a folder for plugin id ${shownValue(ctx.pluginId)}`);
    const dir = join(ctx.dataDir, "plugin-data", ctx.pluginId);
    mkdirSync(dir, { recursive: true });
    return dir;
}

let tmpCount = 0;
const tmpPath = (path: string) => `${path}.${process.pid}.${++tmpCount}.tmp`;

/** Writes `content` to a temporary file and renames it over `path`: a reader sees the old file or the new one, never half */
export function writeAtomicSync(path: string, content: string | Uint8Array): void {
    const tmp = tmpPath(path);
    try {
        writeFileSync(tmp, content);
        renameSync(tmp, path);
    } catch (err) {
        try { unlinkSync(tmp); } catch { }
        throw err;
    }
}

/** writeAtomicSync without blocking main while the file is written */
export async function writeAtomic(path: string, content: string | Uint8Array): Promise<void> {
    const tmp = tmpPath(path);
    try {
        await writeFile(tmp, content);
        await rename(tmp, path);
    } catch (err) {
        await unlink(tmp).catch(() => { });
        throw err;
    }
}

export interface JsonFileOptions<T> {
    /** The value when the file is missing or can't be parsed */
    initial: T;
    /**
     * Turns what JSON.parse read into a T, or throws. Left out, the file's value is used when it has
     * the same JSON type as `initial` (object, array, string...).
     */
    parse?: (raw: unknown) => T;
    /** The largest file read or written. Default 5 MiB */
    maxBytes?: number;
    /** How long after a set the file is written; sets in between are written once. Default 500 */
    debounceMs?: number;
}

export interface JsonFile<T> {
    readonly path: string;
    /** Throws when the file couldn't be read */
    get(): T;
    /** Changes the value now and writes it after debounceMs. Throws a RangeError when the JSON is over maxBytes, and when the file couldn't be read. */
    set(value: T | ((current: T) => T)): void;
    /** Writes a pending change now */
    flush(): Promise<void>;
}

function jsonType(value: unknown) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
}

/**
 * A JSON file in the plugin's folder, read once and kept in memory, written atomically and flushed on
 * stop and quit. An unparseable file is renamed to `<name>.json.bad` and the value starts from
 * `initial`; one that can't be read or moved aside is left alone, and get and set throw a NativeError
 * "file-unreadable" until it can be. Each name gives one shared object per native run.
 */
export function jsonFile<T>(ctx: NativeContext, name: string, options: JsonFileOptions<T>): JsonFile<T> {
    if (typeof name !== "string" || !SAFE_NAME.test(name) || name.startsWith("mist-")) throw new TypeError(`jsonFile: bad file name ${shownValue(name)}. Use letters, digits, _ . and -, not starting with mist-.`);
    return openJson(ctx, name, options);
}

/** The files open in each native run, by path: two helpers for one file share its value and writes */
const open = new WeakMap<NativeContext, Map<string, JsonFile<unknown>>>();

/** jsonFile without the name check, for mist's `mist-` files */
export function openJson<T>(ctx: NativeContext, name: string, options: JsonFileOptions<T>): JsonFile<T> {
    const path = join(dataFolder(ctx), `${name}.json`);
    let files = open.get(ctx);
    if (!files) open.set(ctx, files = new Map());
    let file = files.get(path) as JsonFile<T> | undefined;
    if (!file) files.set(path, (file = makeJson(ctx, name, path, options)) as JsonFile<unknown>);
    return file;
}

function makeJson<T>(ctx: NativeContext, name: string, path: string, options: JsonFileOptions<T>): JsonFile<T> {
    const { initial, maxBytes = 5 * 1024 * 1024, debounceMs = 500 } = options;
    checkNumber("jsonFile", "maxBytes", maxBytes, { min: 1, integer: true });
    checkDelay("jsonFile", "debounceMs", debounceMs);
    const parse = options.parse ?? ((raw: unknown) => {
        if (jsonType(raw) !== jsonType(initial)) throw new TypeError(`expected ${jsonType(initial)}, found ${jsonType(raw)}`);
        return raw as T;
    });

    let value = initial;
    /** Set while the file exists but can't be read: a write then would replace data nobody has seen */
    let failure: NativeError | undefined;

    function load() {
        failure = undefined;
        let raw: string;
        try {
            const { size } = statSync(path);
            if (size > maxBytes) throw new RangeError(`${size} bytes is over maxBytes (${maxBytes})`);
            raw = readFileSync(path, "utf8");
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return;
            failure = unreadable(code ?? errorMessage(err));
            return;
        }
        try {
            value = parse(JSON.parse(raw));
        } catch (err) {
            try {
                renameSync(path, `${path}.bad`);
            } catch (renameErr) {
                // Starting from `initial` now would let the next write replace the file nobody could move aside
                failure = unreadable(`unparseable, and moving it to ${name}.json.bad failed: ${(renameErr as NodeJS.ErrnoException).code ?? errorMessage(renameErr)}`);
                return;
            }
            log.warn(`jsonFile: couldn't parse ${path}. Kept it as ${name}.json.bad and started from the initial value.`, err);
        }
    }
    const unreadable = (why: string) => new NativeError("file-unreadable", { file: `${name}.json` }, `jsonFile: ${name}.json couldn't be read (${why}). It's left untouched until it can be read.`);
    load();
    if (failure) log.error(failure.message);
    /** Throws while the file can't be read, trying it again first */
    const usable = () => {
        if (!failure) return;
        load();
        if (failure) throw failure;
    };

    let text: string | undefined;
    let version = 0;
    let written = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function write() {
        clearTimeout(timer);
        timer = undefined;
        if (written >= version || text === undefined) return;
        const at = version;
        const tmp = tmpPath(path);
        try {
            await writeFile(tmp, text);
            // A newer write, or the flush on stop, may have landed while this one was on disk
            if (written >= at) return void await unlink(tmp).catch(() => { });
            renameSync(tmp, path);
            written = at;
        } catch (err) {
            await unlink(tmp).catch(() => { });
            log.error(`jsonFile: couldn't write ${path}`, err);
        }
    }

    function flushSync() {
        clearTimeout(timer);
        timer = undefined;
        if (written >= version || text === undefined) return;
        try {
            writeAtomicSync(path, text);
            written = version;
        } catch (err) {
            log.error(`jsonFile: couldn't write ${path}`, err);
        }
    }

    ctx.onDispose(flushSync);
    atQuit(ctx, flushSync);

    return {
        path,
        get() {
            usable();
            return value;
        },
        set(next) {
            usable();
            const updated = typeof next === "function" ? (next as (current: T) => T)(value) : next;
            const serialized = jsonText(`jsonFile: ${name}.json`, updated);
            const bytes = Buffer.byteLength(serialized);
            if (bytes > maxBytes) throw new RangeError(`jsonFile: ${name}.json would be ${bytes} bytes, over maxBytes (${maxBytes})`);
            value = updated;
            text = serialized;
            version++;
            clearTimeout(timer);
            timer = setTimeout(() => void write(), debounceMs);
        },
        flush: write,
    };
}
