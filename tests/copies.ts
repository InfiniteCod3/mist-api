import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
