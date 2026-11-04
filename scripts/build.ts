/** Builds dist/: each subpath's JS, .d.ts and source map from src/, and the mist CLI from bin/. */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Output is emitted by the JavaScript TypeScript compiler (typescript-emit). TypeScript 7 typechecks (npm run typecheck).
const tsc = join(root, "node_modules", "typescript-emit", "bin", "tsc");

if (!existsSync(join(root, "node_modules", ".evi", "src", "api", "index.ts"))) {
    console.error("node_modules/.evi isn't linked to an Evi checkout, so @evi/api has no types to build against. Run bun scripts/setup.ts.");
    process.exit(1);
}

rmSync(join(root, "dist"), { recursive: true, force: true });
const build = (config: string) => execFileSync(process.execPath, [tsc, "-p", join(root, config)], { cwd: root, stdio: "inherit" });
build("tsconfig.bin.json");
build("tsconfig.build.json");
