/** A plugin's own folder under Evi's data folder, and JSON files in it that survive a crash mid-write. */
import type { NativeContext } from "@evi/api/native";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { log } from "./native.ts";

const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * The plugin's own folder, `<ctx.dataDir>/plugin-data/<plugin id>`, made if missing. `ctx.dataDir` is
 * Evi's data folder, shared by Evi and every plugin; its `plugins` folder holds installed plugins'
 * code, so plugin data stays out of it.
 */
export function dataFolder(ctx: NativeContext): string {
    if (!SAFE_NAME.test(ctx.pluginId)) throw new Error(`Can't make a folder for plugin id ${JSON.stringify(ctx.pluginId)}`);
    const dir = join(ctx.dataDir, "plugin-data", ctx.pluginId);
    mkdirSync(dir, { recursive: true });
    return dir;
}

let tmpCount = 0;
const tmpPath = (path: string) => `${path}.${process.pid}.${++tmpCount}.tmp`;

/** Writes `text` to a temporary file and renames it over `path`, so a reader sees the old file or the new one, never half */
export function writeAtomicSync(path: string, text: string) {
    const tmp = tmpPath(path);
    try {
        writeFileSync(tmp, text);
        renameSync(tmp, path);
    } catch (err) {
        try { unlinkSync(tmp); } catch { }
        throw err;
    }
}

export interface JsonFileOptions<T> {
    /** The value when the file is missing or can't be read */
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
    get(): T;
    /** Changes the value now and writes it after debounceMs. Throws a RangeError when the JSON is over maxBytes. */
    set(value: T | ((current: T) => T)): void;
    /** Writes a pending change now */
    flush(): Promise<void>;
}

const jsonType = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

/**
 * A JSON file in the plugin's own folder (dataFolder), read once when made and kept in memory.
 * Writes go to a temporary file renamed over the old one. A pending write is flushed when the
 * native side stops. A file that can't be read or parsed is renamed to `<name>.json.bad`, and the
 * value starts from `initial`.
 */
export function jsonFile<T>(ctx: NativeContext, name: string, options: JsonFileOptions<T>): JsonFile<T> {
    if (!SAFE_NAME.test(name) || name.startsWith("mist-")) throw new Error(`Bad file name ${JSON.stringify(name)}: use letters, digits, _ . and -, not starting with mist-`);
    return openJson(ctx, name, options);
}

/** jsonFile without the name check, for mist's own `mist-` files */
export function openJson<T>(ctx: NativeContext, name: string, options: JsonFileOptions<T>): JsonFile<T> {
    const { initial, maxBytes = 5 * 1024 * 1024, debounceMs = 500 } = options;
    const parse = options.parse ?? ((raw: unknown) => {
        if (jsonType(raw) !== jsonType(initial)) throw new TypeError(`expected ${jsonType(initial)}, found ${jsonType(raw)}`);
        return raw as T;
    });
    const path = join(dataFolder(ctx), `${name}.json`);

    let value = initial;
    try {
        const { size } = statSync(path);
        if (size > maxBytes) throw new RangeError(`${size} bytes is over maxBytes (${maxBytes})`);
        value = parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            log.warn(`Couldn't read ${path}, kept as ${name}.json.bad; starting from the initial value`, err);
            try { renameSync(path, `${path}.bad`); } catch { }
        }
    }

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
            log.error(`Couldn't write ${path}`, err);
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
            log.error(`Couldn't write ${path}`, err);
        }
    }

    ctx.onDispose(flushSync);

    return {
        path,
        get: () => value,
        set(next) {
            const updated = typeof next === "function" ? (next as (current: T) => T)(value) : next;
            const serialized = JSON.stringify(updated);
            if (serialized === undefined) throw new TypeError(`${name}.json can't hold ${typeof updated}`);
            const bytes = Buffer.byteLength(serialized);
            if (bytes > maxBytes) throw new RangeError(`${name}.json would be ${bytes} bytes, over maxBytes (${maxBytes})`);
            value = updated;
            text = serialized;
            version++;
            clearTimeout(timer);
            timer = setTimeout(() => void write(), debounceMs);
        },
        flush: write,
    };
}
