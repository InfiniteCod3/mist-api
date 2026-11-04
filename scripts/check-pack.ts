/**
 * Asserts what `npm pack` would publish: every file that package.json's exports and bin point at,
 * and nothing from src, tests, scripts or the Evi checkout. Run it after the build.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const answer = JSON.parse(execSync("npm pack --dry-run --json --ignore-scripts", { cwd: root, encoding: "utf8" }));
// npm 10 answers with an array, npm 11 and later with an object keyed by package name
const packed = Array.isArray(answer) ? answer[0] : Object.values(answer)[0] as { filename: string; files: { path: string; }[]; };
const files = new Set<string>(packed.files.map((f: { path: string; }) => f.path.replaceAll("\\", "/")));

const targets = (value: unknown): string[] =>
    typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(targets) : [];
const wanted = [...new Set([...targets(pkg.exports), ...targets(pkg.bin), pkg.main, pkg.types, "README.md", "CHANGELOG.md", "SECURITY.md", "LICENSE"]
    .map((path: string) => path.replace(/^\.\//, "")))];

const problems = [
    ...wanted.filter(path => !files.has(path)).map(path => `missing ${path}`),
    ...[...files].filter(path => /^(src|tests|scripts|\.evi|node_modules|\.github)\//.test(path) || path.startsWith(".evi")).map(path => `shouldn't ship ${path}`),
];
for (const bin of targets(pkg.bin)) {
    if (!readFileSync(join(root, bin), "utf8").startsWith("#!/usr/bin/env node\n")) problems.push(`${bin} doesn't start with a node shebang`);
}

if (problems.length) {
    console.error(`${packed.filename} isn't ready to publish:\n  ${problems.join("\n  ")}`);
    process.exit(1);
}
console.log(`${packed.filename}: ${files.size} files, ${wanted.length} entry points present, no sources or tests`);
