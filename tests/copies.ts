import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A second copy of mist-api's sources, as a second plugin's bundle carries one: its own modules,
 * its own state, at `version`. Returns its directory and a cleanup. `eviApi` replaces the copy's
 * `@evi/api` imports, which don't resolve from a temporary directory, with a specifier to mock.
 */
export function copyOfSources(version: string, eviApi?: string) {
    const dir = mkdtempSync(join(tmpdir(), "mist-copy-"));
    cpSync(join(import.meta.dir, "..", "src"), dir, { recursive: true });
    const protocol = join(dir, "protocol.ts");
    writeFileSync(protocol, readFileSync(protocol, "utf8").replace(/MIST_VERSION = "[^"]+"/, `MIST_VERSION = "${version}"`));
    if (eviApi) {
        for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(f => f.endsWith(".ts")).map(f => join(dir, f))) {
            writeFileSync(file, readFileSync(file, "utf8").replaceAll('from "@evi/api"', `from ${JSON.stringify(eviApi)}`));
        }
    }
    return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
