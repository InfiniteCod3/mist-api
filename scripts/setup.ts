/**
 * Points `.evi` at an Evi checkout ($EVI_DIR, a sibling ../evi, or a shallow clone of BleedDev/evi) so
 * `@evi/api` resolves for typechecking, and links node_modules/.evi to it for the build. An existing
 * .evi is kept unless --force is passed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const link = join(root, ".evi");
const force = process.argv.includes("--force");
const isEvi = (dir: string) => existsSync(join(dir, "src", "api", "index.ts"));

function run(cmd: string, args: string[], cwd = root) {
    execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

const lstat = (path: string) => { try { return lstatSync(path); } catch { return null; } };
/** Removes a link as a link: following it would delete the Evi checkout it points at */
const remove = (path: string) => {
    const stat = lstat(path);
    if (stat?.isSymbolicLink()) unlinkSync(path);
    else if (stat) rmSync(path, { recursive: true, force: true });
};
const linkDir = (target: string, path: string) => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");

if (lstat(link) && !force) {
    if (!isEvi(link)) throw new Error(`${link} exists but is not an Evi checkout. Rerun with --force to replace it.`);
    console.log(`.evi already points at an Evi checkout`);
} else {
    remove(link);
    const candidates = [process.env.EVI_DIR, join(root, "..", "evi")].filter((d): d is string => !!d).map(d => resolve(d));
    const found = candidates.find(isEvi);
    if (found) {
        linkDir(found, link);
        console.log(`.evi -> ${found}`);
    } else {
        run("git", ["clone", "--depth", "1", "https://github.com/BleedDev/evi.git", link]);
        console.log(`Cloned BleedDev/evi into .evi`);
    }
}

// Types only: no install scripts, since Electron downloads its binary in one
if (!existsSync(join(link, "node_modules"))) run("bun", ["install", "--ignore-scripts"], link);

// tsconfig.build.json reads Evi through node_modules, so the compiler neither emits it nor checks its rootDir
const types = join(root, "node_modules", ".evi");
if (!isEvi(types)) {
    remove(types);
    mkdirSync(dirname(types), { recursive: true });
    linkDir(realpathSync(link), types);
    console.log(`node_modules/.evi -> ${realpathSync(link)}`);
}
