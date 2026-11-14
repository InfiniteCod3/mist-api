/** mist manifest fix and bump: a plugin's manifest.json checked against Evi's store rules, and its next version, without Discord */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { CdpError } from "./cdp.ts";

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
export function compareVersions(a: string, b: string): number {
    const parse = (v: string) => {
        const [core, ...pre] = v.split("+")[0].split("-");
        return { core: core.split(".").map(n => Number(n) || 0), pre: pre.length ? pre.join("-").split(".") : [] };
    };
    const pa = parse(a), pb = parse(b);
    for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
        const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
        if (d) return d;
    }
    if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length;
    const numeric = (x: string) => /^\d+$/.test(x);
    for (let i = 0; i < Math.min(pa.pre.length, pb.pre.length); i++) {
        const [x, y] = [pa.pre[i], pb.pre[i]];
        const d = numeric(x) && numeric(y) ? Number(x) - Number(y) : numeric(x) ? -1 : numeric(y) ? 1 : x < y ? -1 : x > y ? 1 : 0;
        if (d) return d;
    }
    return pa.pre.length - pb.pre.length;
}

const text = (v: unknown) => typeof v === "string" && v.trim().length > 0;

export interface Fix {
    manifest: Manifest;
    /** What Evi's check (missingTranslations) would say is missing, as `de name` */
    missing: string[];
    /** Versions whose notes in other languages were dropped to fit */
    trimmed: string[];
    bytes: { before: number; after: number; };
    /** Bytes still over the limit once every old translated note is gone; 0 when it fits. When over, nothing is dropped. */
    over: number;
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
    const entry = Array.isArray(manifest.changelog) ? manifest.changelog.find(c => c?.version === version) : undefined;
    const english = Array.isArray(entry?.notes) ? entry.notes : [];
    const missing: string[] = [];
    for (const lang of LANGUAGES) {
        const locale = (manifest.locales ??= {})[lang] ??= {};
        if (!text(locale.name)) {
            missing.push(`${lang} name`);
            if (manifest.name) locale.name = manifest.name;
        }
        if (text(manifest.description) && !text(locale.description)) {
            missing.push(`${lang} description`);
            locale.description = manifest.description;
        }
        if (entry && !(Array.isArray(locale.changelog?.[version]) && locale.changelog[version].length)) {
            missing.push(`${lang} ${version} notes`);
            if (english.length) (locale.changelog ??= {})[version] = [...english];
        }
    }

    const old = [...new Set(Object.values(manifest.locales ?? {}).flatMap(l => Object.keys(l.changelog ?? {})))]
        .filter(v => v !== version)
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
    if (after > MAX_BYTES) return { manifest: translated, missing, trimmed: [], bytes: { before, after: builtBytes(translated, dirName, native) }, over: after - MAX_BYTES };
    return { manifest, missing, trimmed, bytes: { before, after }, over: 0 };
}

export interface FixRun extends Fix { path: string; written: boolean; }

interface ManifestFile { root: string; path: string; raw: string; manifest: Manifest; native: boolean; }

function readManifest(dir: string): ManifestFile {
    const root = resolve(dir);
    const path = join(root, "manifest.json");
    if (!existsSync(path)) throw new CdpError(`No manifest.json in ${root}`);
    const raw = readFileSync(path, "utf8");
    let manifest: Manifest;
    try {
        manifest = JSON.parse(raw);
    } catch (err) {
        throw new CdpError(`${path} isn't JSON: ${(err as Error).message}`);
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new CdpError(`${path} isn't a JSON object`);
    // scripts/build.ts findEntry: a native.ts, .tsx, .js or .jsx next to the manifest is the native side
    const native = ["ts", "tsx", "js", "jsx"].some(ext => existsSync(join(root, `native.${ext}`)));
    return { root, path, raw, manifest, native };
}

/** `value` as JSON written the way `raw` is: its line endings, its indentation, its final newline or none */
export function formatLike(raw: string, value: unknown): string {
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const indent = /^[{[][^\S\r\n]*\r?\n([ \t]+)\S/.exec(raw.trimStart())?.[1] ?? 4;
    const final = /\r?\n$/.test(raw) ? eol : "";
    return JSON.stringify(value, null, indent).replace(/\n/g, eol) + final;
}

export function fixManifestDir(dir: string, write: boolean): FixRun {
    const { root, path, raw, manifest, native } = readManifest(dir);
    const fix = fixManifest(manifest, basename(root), native);
    const changed = !fix.over && (fix.missing.length > 0 || fix.trimmed.length > 0);
    if (write && changed) writeFileSync(path, formatLike(raw, fix.manifest));
    return { ...fix, path, written: write && changed };
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

export function fixLines(r: FixRun): string[] {
    const did = r.written ? "" : "would ";
    const out = [`${r.path}: built, ${kb(r.bytes.before)} of Evi's ${kb(MAX_BYTES)}`];
    if (!r.missing.length) out.push("Every language Evi ships has its name, description and this version's notes.");
    else out.push(`Missing translations: ${r.missing.join(", ")}`, `  ${r.written ? "Added" : r.over ? "Once it fits, --write adds" : "--write adds"} each as a copy of the English text. Translate them before uploading.`);
    if (r.trimmed.length) out.push(`Over the limit: ${did}drop the other languages' notes for ${r.trimmed.join(", ")} (English ones stay), to ${kb(r.bytes.after)}`);
    if (r.over) out.push(`${r.over} bytes over even with every old translated note gone, so nothing is dropped and nothing written: shorten the English changelog or this version's translations.`);
    else if (!r.written && (r.missing.length || r.trimmed.length)) out.push("Nothing written: run with --write to change manifest.json.");
    return out;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** The version after `current`: "patch", "minor" or "major" counts up (dropping a prerelease tag), anything else must be a higher semver */
export function nextVersion(current: string | undefined, target: string): string {
    const core = current && /^(\d+)\.(\d+)\.(\d+)/.exec(current);
    const step = ["major", "minor", "patch"].indexOf(target);
    if (step >= 0) {
        if (!core) throw new CdpError(`manifest.json has no version to count up from: give the new version, as in 1.0.0`);
        const parts = core.slice(1).map(Number);
        parts[step]++;
        parts.fill(0, step + 1);
        return parts.join(".");
    }
    if (!SEMVER.test(target)) throw new CdpError(`${target} isn't a version: give patch, minor, major, or a version such as 1.2.3`);
    if (current && compareVersions(target, current) <= 0) throw new CdpError(`${target} isn't higher than the current version ${current}`);
    return target;
}

export interface Bump extends Fix {
    from: string | null;
    to: string;
    /** Languages that got a copy of the English notes, for want of their own `--note-<lang>` */
    copied: string[];
}

/**
 * Sets the version and adds its changelog entry: `notes.en` in English, and for each language Evi
 * ships its own `notes[lang]` or a copy of the English notes. Then fills other gaps and fits the
 * 16 KB as `fixManifest` does.
 */
export function bumpManifest(input: Manifest, target: string, notes: Record<string, string[]>, dirName: string, native: boolean): Bump {
    const english = notes.en ?? [];
    if (!english.length || !english.every(text)) throw new CdpError(`mist manifest bump needs the English notes: --note "What changed"`);
    for (const [lang, list] of Object.entries(notes)) {
        if (lang !== "en" && !(LANGUAGES as readonly string[]).includes(lang)) throw new CdpError(`--note-${lang}: Evi's store languages are ${LANGUAGES.join(", ")}`);
        if (!list.every(text)) throw new CdpError(`--note${lang === "en" ? "" : `-${lang}`} needs text`);
    }
    const from = typeof input.version === "string" ? input.version : null;
    const to = nextVersion(from ?? undefined, target);
    const manifest: Manifest = structuredClone(input);
    const changelog = Array.isArray(manifest.changelog) ? manifest.changelog : [];
    if (changelog.some(c => c?.version === to)) throw new CdpError(`The changelog already has an entry for ${to}`);
    manifest.version = to;
    manifest.changelog = [{ version: to, notes: [...english] }, ...changelog];
    const copied: string[] = [];
    for (const lang of LANGUAGES) {
        const locale = (manifest.locales ??= {})[lang] ??= {};
        if (!notes[lang]) copied.push(lang);
        // Newest first, as the English changelog is
        locale.changelog = { [to]: [...notes[lang] ?? english], ...locale.changelog };
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

export function bumpLines(r: BumpRun): string[] {
    const be = r.written ? "" : "would be ";
    const out = [`${r.path}: ${r.from ?? "no version"} -> ${r.to}`];
    if (r.copied.length) out.push(`English notes ${be}copied to ${r.copied.join(", ")}. Translate them before uploading.`);
    if (r.missing.length) out.push(`Also missing, ${be}filled with the English text: ${r.missing.join(", ")}`);
    if (r.trimmed.length) out.push(`Over the limit: the other languages' notes for ${r.trimmed.join(", ")} ${be || "are "}dropped (English ones stay)`);
    if (r.over) out.push(`${r.over} bytes over Evi's ${kb(MAX_BYTES)} even with every old translated note gone, so nothing is written: shorten the notes.`);
    else out.push(`Built, ${kb(r.bytes.after)} of Evi's ${kb(MAX_BYTES)}`);
    if (!r.written && !r.over) out.push("Nothing written: run with --write to change manifest.json.");
    return out;
}
