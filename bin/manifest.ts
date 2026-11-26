/** mist manifest fix and bump: a plugin's manifest.json checked against Evi's store rules, and its next version, without Discord */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { CliError } from "./cdp.ts";
import { errorText } from "./format.ts";

/** Evi's PLUGIN_LANGUAGES (src/shared/pluginTranslations.ts): every store plugin speaks each */
export const LANGUAGES = ["de", "es", "fr", "ja", "pl", "pt-BR", "ru", "tr"] as const;
/** Evi's plugin CLI refuses to upload a built manifest.json over 16 KB */
export const MAX_BYTES = 16 * 1024;

interface Note { version: string; notes: string[]; }
interface Locale { name?: string; description?: string; changelog?: Record<string, string[]>; }
export interface Manifest { id?: string; name?: string; description?: string; version?: string; changelog?: Note[]; locales?: Record<string, Locale>; [key: string]: unknown; }

/** The manifest as Evi's build writes it to dist/plugins/<id>/manifest.json (scripts/build.ts buildPlugin) */
export function builtBytes(manifest: Manifest, dirName: string, native: boolean): number {
    const built: Manifest = { ...manifest, id: manifest.id ?? dirName };
    if (native) built.native = "native.js";
    built.main = "index.js";
    return Buffer.byteLength(JSON.stringify(built, null, 4));
}

/** Semver order: a prerelease comes before its release, and its identifiers compare one by one */
function compareVersions(a: string, b: string): number {
    const parse = (version: string) => {
        const [core, ...pre] = version.split("+")[0].split("-");
        return { core: core.split(".").map(part => Number(part) || 0), pre: pre.length ? pre.join("-").split(".") : [] };
    };
    const left = parse(a), right = parse(b);
    for (let i = 0; i < Math.max(left.core.length, right.core.length); i++) {
        const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
        if (diff) return diff;
    }
    if (!left.pre.length || !right.pre.length) return right.pre.length - left.pre.length;
    for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i++) {
        const diff = comparePrerelease(left.pre[i], right.pre[i]);
        if (diff) return diff;
    }
    return left.pre.length - right.pre.length;
}

/** Semver's order of two prerelease identifiers: numbers by value and before words, words by ASCII */
function comparePrerelease(a: string, b: string): number {
    const numeric = (identifier: string) => /^\d+$/.test(identifier);
    if (numeric(a) && numeric(b)) return Number(a) - Number(b);
    if (numeric(a)) return -1;
    if (numeric(b)) return 1;
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

const hasText = (value: unknown) => typeof value === "string" && value.trim().length > 0;

export interface Fix {
    manifest: Manifest;
    /** What Evi's check (missingTranslations) would say is missing, as `de name` */
    missing: string[];
    /** Versions whose notes in other languages were dropped to fit */
    trimmed: string[];
    bytes: { before: number; after: number; };
    /** Bytes still over the limit once every old translated note is gone; 0 when it fits. When over, nothing is dropped. */
    over: number;
    /** manifest.json has no English name to copy: the translated names stay missing */
    nameless: boolean;
    /** `manifest` differs from the input */
    changed: boolean;
}

/**
 * Adds each missing translation as a copy of the English text, for a translator to replace, then
 * drops the other languages' notes for old versions, oldest first, until the built manifest fits.
 * English notes stay, and a language without notes for a version shows the English ones. When even
 * dropping all of them wouldn't fit, it drops none, and `over` says by how much.
 */
export function fixManifest(input: Manifest, dirName: string, native: boolean): Fix {
    const manifest: Manifest = structuredClone(input);
    const before = builtBytes(manifest, dirName, native);
    const version = manifest.version ?? "";
    // As Evi's missingTranslations: an entry for this version asks for notes, even an empty one
    const entry = Array.isArray(manifest.changelog) ? manifest.changelog.find(note => note?.version === version) : undefined;
    const english = Array.isArray(entry?.notes) ? entry.notes : [];
    const nameless = !hasText(manifest.name);
    const missing: string[] = [];
    for (const lang of LANGUAGES) {
        const locale = manifest.locales?.[lang] ?? {};
        if (!hasText(locale.name)) {
            missing.push(`${lang} name`);
            if (!nameless) locale.name = manifest.name;
        }
        if (hasText(manifest.description) && !hasText(locale.description)) {
            missing.push(`${lang} description`);
            locale.description = manifest.description;
        }
        if (entry && !(Array.isArray(locale.changelog?.[version]) && locale.changelog[version].length)) {
            missing.push(`${lang} ${version} notes`);
            if (english.length) (locale.changelog ??= {})[version] = [...english];
        }
        if (Object.keys(locale).length) (manifest.locales ??= {})[lang] = locale;
    }

    const old = [...new Set(Object.values(manifest.locales ?? {}).flatMap(locale => Object.keys(locale.changelog ?? {})))]
        .filter(older => older !== version)
        .sort(compareVersions);
    const translated = structuredClone(manifest);
    const trimmed: string[] = [];
    while (builtBytes(manifest, dirName, native) > MAX_BYTES && old.length) {
        const drop = old.shift()!;
        trimmed.push(drop);
        for (const locale of Object.values(manifest.locales ?? {})) {
            if (!locale.changelog) continue;
            delete locale.changelog[drop];
            if (!Object.keys(locale.changelog).length) delete locale.changelog;
        }
    }
    const after = builtBytes(manifest, dirName, native);
    const changed = (out: Manifest) => JSON.stringify(out) !== JSON.stringify(input);
    if (after > MAX_BYTES) return { manifest: translated, missing, trimmed: [], bytes: { before, after: builtBytes(translated, dirName, native) }, over: after - MAX_BYTES, nameless, changed: changed(translated) };
    return { manifest, missing, trimmed, bytes: { before, after }, over: 0, nameless, changed: changed(manifest) };
}

export interface FixRun extends Fix { path: string; written: boolean; }

interface ManifestFile { root: string; path: string; raw: string; manifest: Manifest; native: boolean; }

function readManifest(dir: string): ManifestFile {
    const root = resolve(dir);
    const path = join(root, "manifest.json");
    if (!existsSync(path)) throw new CliError(`No manifest.json in ${root}`);
    const raw = readFileSync(path, "utf8");
    let manifest: Manifest;
    try {
        manifest = JSON.parse(raw);
    } catch (err) {
        throw new CliError(`${path} isn't JSON: ${errorText(err)}`);
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new CliError(`${path} isn't a JSON object`);
    // scripts/build.ts findEntry: a native.ts, .tsx, .js or .jsx next to the manifest is the native side
    const native = ["ts", "tsx", "js", "jsx"].some(ext => existsSync(join(root, `native.${ext}`)));
    return { root, path, raw, manifest, native };
}

/** `value` as JSON written the way `raw` is: its line endings, its indentation, its final newline or none */
function formatLike(raw: string, value: unknown): string {
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const indent = /^[{[][^\S\r\n]*\r?\n([ \t]+)\S/.exec(raw.trimStart())?.[1] ?? 4;
    const final = /\r?\n$/.test(raw) ? eol : "";
    return JSON.stringify(value, null, indent).replace(/\n/g, eol) + final;
}

export function fixManifestDir(dir: string, write: boolean): FixRun {
    const { root, path, raw, manifest, native } = readManifest(dir);
    const fix = fixManifest(manifest, basename(root), native);
    const written = write && !fix.over && fix.changed;
    if (written) writeFileSync(path, formatLike(raw, fix.manifest));
    return { ...fix, path, written };
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const NAMELESS = "manifest.json has no name to copy into the translations: add one.";

/** Who adds the missing translations: this run, or a run with --write once the manifest fits */
function adder(run: FixRun): string {
    if (run.written) return "Added";
    if (run.over) return "Once it fits, --write adds";
    return "--write adds";
}

export function fixLines(run: FixRun): string[] {
    const did = run.written ? "" : "would ";
    const out = [`${run.path}: built, ${kb(run.bytes.before)} of Evi's ${kb(MAX_BYTES)}`];
    if (!run.missing.length) out.push("Every language Evi ships has its name, description and this version's notes.");
    else if (run.nameless) out.push(NAMELESS);
    else out.push(`Missing translations: ${run.missing.join(", ")}`, `  ${adder(run)} each as a copy of the English text. Translate them before uploading.`);
    if (run.trimmed.length) out.push(`Over the limit: ${did}drop the other languages' notes for ${run.trimmed.join(", ")} (English ones stay), to ${kb(run.bytes.after)}`);
    if (run.over) out.push(`${run.over} bytes over even with every old translated note gone. Nothing dropped or written: shorten the English changelog or this version's translations.`);
    else if (!run.written && run.changed) out.push("Nothing written: run with --write to change manifest.json.");
    return out;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** The version after `current`: "patch", "minor" or "major" counts up (dropping a prerelease tag), anything else must be a higher semver */
export function nextVersion(current: string | undefined, target: string): string {
    const core = current && /^(\d+)\.(\d+)\.(\d+)/.exec(current);
    const step = ["major", "minor", "patch"].indexOf(target);
    if (step >= 0) {
        if (!core) throw new CliError(`manifest.json has no version to count up from: give the new version, as in 1.0.0`);
        const parts = core.slice(1).map(Number);
        parts[step]++;
        parts.fill(0, step + 1);
        return parts.join(".");
    }
    if (!SEMVER.test(target)) throw new CliError(`${target} isn't a version: give patch, minor, major, or a version such as 1.2.3`);
    if (current && compareVersions(target, current) <= 0) throw new CliError(`${target} isn't higher than the current version ${current}`);
    return target;
}

export interface Bump extends Fix {
    from: string | null;
    to: string;
    /** Languages that got a copy of the English notes, for want of a `--note-<lang>` */
    copied: string[];
}

/**
 * Sets the version and adds its changelog entry: `notes.en` in English, and for each language Evi
 * ships `notes[lang]` or a copy of the English notes. Then fills other gaps and fits the
 * 16 KB as `fixManifest` does.
 */
export function bumpManifest(input: Manifest, target: string, notes: Record<string, string[]>, dirName: string, native: boolean): Bump {
    const english = notes.en ?? [];
    if (!english.length || !english.every(hasText)) throw new CliError(`mist manifest bump needs the English notes: --note "What changed"`);
    for (const [lang, list] of Object.entries(notes)) {
        if (lang !== "en" && !(LANGUAGES as readonly string[]).includes(lang)) throw new CliError(`--note-${lang}: Evi's store languages are ${LANGUAGES.join(", ")}`);
        if (!list.every(hasText)) throw new CliError(`--note${lang === "en" ? "" : `-${lang}`} needs text`);
    }
    const from = typeof input.version === "string" ? input.version : null;
    const to = nextVersion(from ?? undefined, target);
    const manifest: Manifest = structuredClone(input);
    const changelog = Array.isArray(manifest.changelog) ? manifest.changelog : [];
    if (changelog.some(note => note?.version === to)) throw new CliError(`The changelog already has an entry for ${to}`);
    manifest.version = to;
    manifest.changelog = [{ version: to, notes: [...english] }, ...changelog];
    const copied: string[] = [];
    for (const lang of LANGUAGES) {
        const locale = (manifest.locales ??= {})[lang] ??= {};
        if (!notes[lang]) copied.push(lang);
        // Newest first, as the English changelog is. Notes a locale already had for this version are stale.
        const { [to]: _stale, ...older } = locale.changelog ?? {};
        locale.changelog = { [to]: [...notes[lang] ?? english], ...older };
    }
    return { ...fixManifest(manifest, dirName, native), from, to, copied };
}

export interface BumpRun extends Bump { path: string; written: boolean; }

export function bumpManifestDir(dir: string, target: string, notes: Record<string, string[]>, write: boolean): BumpRun {
    const { root, path, raw, manifest, native } = readManifest(dir);
    const bump = bumpManifest(manifest, target, notes, basename(root), native);
    const written = write && !bump.over;
    if (written) writeFileSync(path, formatLike(raw, bump.manifest));
    return { ...bump, path, written };
}

export function bumpLines(run: BumpRun): string[] {
    const be = run.written ? "" : "would be ";
    const out = [`${run.path}: ${run.from ?? "no version"} -> ${run.to}`];
    if (run.copied.length) out.push(`English notes ${be}copied to ${run.copied.join(", ")}. Translate them before uploading.`);
    if (run.missing.length) out.push(`Also missing, ${be}filled with the English text: ${run.missing.join(", ")}`);
    if (run.nameless) out.push(NAMELESS);
    if (run.trimmed.length) out.push(`Over the limit: the other languages' notes for ${run.trimmed.join(", ")} ${be || "are "}dropped (English ones stay)`);
    if (run.over) out.push(`${run.over} bytes over Evi's ${kb(MAX_BYTES)} even with every old translated note gone. Nothing written: shorten the notes.`);
    else out.push(`Built, ${kb(run.bytes.after)} of Evi's ${kb(MAX_BYTES)}`);
    if (!run.written && !run.over) out.push("Nothing written: run with --write to change manifest.json.");
    return out;
}
