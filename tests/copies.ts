import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A second copy of mist-api's sources, as a second plugin's bundle carries one: its own modules,
 * its own state, at `version`. Returns its directory and a cleanup.
 */
export function copyOfSources(version: string) {
    const dir = mkdtempSync(join(tmpdir(), "mist-copy-"));
    cpSync(join(import.meta.dir, "..", "src"), dir, { recursive: true });
    const protocol = join(dir, "protocol.ts");
    writeFileSync(protocol, readFileSync(protocol, "utf8").replace(/MIST_VERSION = "[^"]+"/, `MIST_VERSION = "${version}"`));
    // The preloaded Electron stand-in is found from tests/ only; a copy's imports just need to resolve
    mkdirSync(join(dir, "node_modules", "electron"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "electron", "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
    writeFileSync(join(dir, "node_modules", "electron", "index.js"), "export const BrowserWindow = {}, dialog = {}, safeStorage = {};");
    return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** mist-api's sources as released at `tag`, as a plugin built against that release carries them */
export function copyOfRelease(tag: string) {
    const dir = mkdtempSync(join(tmpdir(), `mist-${tag}-`));
    const repo = join(import.meta.dir, "..");
    for (const file of execFileSync("git", ["ls-tree", "--name-only", `${tag}:src`], { cwd: repo, encoding: "utf8" }).split(/\s+/).filter(Boolean)) {
        writeFileSync(join(dir, file), execFileSync("git", ["show", `${tag}:src/${file}`], { cwd: repo }));
    }
    return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
