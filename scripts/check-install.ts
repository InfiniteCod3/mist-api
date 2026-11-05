/**
 * Installs the packed tarball into a fresh project, the way a plugin author gets it, and checks
 * that the CLI runs with Node, that a file importing every subpath typechecks against the packed
 * types, that the testing subpath runs under plain Node, and that a Bun bundle of a small plugin
 * carries only what it imports. Run after the build.
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const evi = realpathSync(join(root, ".evi")).replaceAll("\\", "/");
const dir = mkdtempSync(join(tmpdir(), "mist-install-"));
const problems: string[] = [];

try {
    execSync(`npm pack --ignore-scripts --pack-destination "${dir}"`, { cwd: root, stdio: "ignore" });
    const tarball = join(dir, `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`);
    const app = join(dir, "app");
    mkdirSync(join(app, "plugin"), { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app", private: true, type: "module" }));
    execSync(`npm install --no-audit --no-fund --ignore-scripts "${tarball}"`, { cwd: app, stdio: "ignore" });

    const help = execSync("npx --no-install mist --help", { cwd: app, encoding: "utf8" });
    if (!help.startsWith("mist <command>")) problems.push(`npx mist --help printed ${JSON.stringify(help.slice(0, 80))}`);

    const name = pkg.name;
    writeFileSync(join(app, "check.ts"), `
import type { SettingsSchema } from "@evi/api";
import { createMist, MIST_VERSION } from "${name}";
import { channel, slot } from "${name}/bus";
import { accounts, DiscordApiError, discord, format, PluginPermissionError } from "${name}/discord";
import { defineNative } from "${name}/native";
import { type ChangeSource, currentUserId, stores, subscribe, useStore } from "${name}/stores";
import { fakeContext, fakeEvi, fakeStore } from "${name}/testing";
import { boundary, chatBar, messages, state, useValue } from "${name}/ui";
import { fetchJson, isRecord, sleep } from "${name}/util";

const native = defineNative({ add: (a: number, b: number) => a + b });
const settings = { volume: { type: "number", label: "Volume", default: 50 } } satisfies SettingsSchema;
const mist = createMist<typeof settings, typeof native>("check");
export async function run() {
    const sum: number = await mist.native.add(1, 2);
    // @ts-expect-error the packed types know native.ts's argument types
    await mist.native.add("1", 2);
    const volume: number = mist.ctx.settings.get("volume");
    mist.ctx.onDispose(subscribe([stores.presence, stores.sessions], () => { }));
    const text: string | undefined = mist.safe((line: { text?: string; }) => line.text!.trim(), line => line.text)({});
    const source: ChangeSource = { addChangeListener() { }, removeChangeListener() { } };
    const count = state(0);
    mist.ctx.onDispose(subscribe(count, () => { }));
    messages.beforeSend(mist, "trim", draft => { draft.content = draft.content.trim(); });
    // @ts-expect-error a draft's content is a string
    messages.beforeEdit(mist, "bad", draft => { draft.content = draft.message.id.length; });
    const api = discord(mist);
    for await (const message of api.messages("1", { limit: 1 })) { const id: string = message.id; void id; }
    // @ts-expect-error a page goes from before or from after, not both
    api.messages("1", { before: "1", after: "2" });
    const me: unknown = await discord("check").rest.get("/users/@me");
    const when: string = format.ago(Date.now());
    void [sum, volume, text, source, channel, slot, currentUserId, useStore, MIST_VERSION, fetchJson, isRecord, sleep, accounts, DiscordApiError, PluginPermissionError, me, when, boundary, useValue, chatBar.patches];
}
export function test() {
    const evi = fakeEvi();
    const run = fakeContext<typeof settings>({ schema: settings, evi });
    const loud: number = run.ctx.settings.get("volume");
    // @ts-expect-error the fake context is typed by the plugin's settings
    run.ctx.settings.get("missing");
    const store = fakeStore({ count: 1 });
    store.change({ count: 2 });
    evi.addStore("CountStore", store);
    void [loud, evi.module.findStore("CountStore")];
}
`);
    // The tsconfig the README gives a plugin outside an Evi checkout
    writeFileSync(join(app, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "ES2022", module: "ESNext", moduleResolution: "Bundler", lib: ["ES2023", "DOM", "DOM.Iterable"], jsx: "react-jsx",
            strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, resolveJsonModule: true,
            paths: { "@evi/api": [`${evi}/src/api/index.ts`], "@evi/api/*": [`${evi}/src/api/*`], "@shared/*": [`${evi}/src/shared/*`] },
        },
        include: ["check.ts", `${evi}/src/shared/globals.d.ts`],
    }));
    try {
        execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", app], { cwd: app, encoding: "utf8" });
    } catch (err) {
        problems.push(`a file importing every subpath doesn't typecheck against the packed types:\n${(err as { stdout?: string; }).stdout}`);
    }

    // No test runner in sight: plain Node imports the testing subpath and uses it
    let tested: string;
    try {
        tested = execFileSync("node", ["--input-type=module", "-e", `
import { fakeContext, fakeEvi, fakeStore } from "${name}/testing";
const evi = fakeEvi();
const run = fakeContext({ settings: { volume: 3 }, evi });
const store = fakeStore({ n: 1 });
run.ctx.waitFor(evi.module.filters.byStoreName("NStore"), s => run.ctx.logger.info("found", s.n));
evi.addStore("NStore", store);
run.dispose();
console.log(JSON.stringify([run.ctx.settings.get("volume"), run.logs[0].args]));
`], { cwd: app, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (err) {
        tested = String((err as { stderr?: string; }).stderr).split(/\r?\n/).find(line => line.startsWith("Error")) ?? String(err);
    }
    if (tested !== '[3,["found",1]]') problems.push(`the testing subpath under Node printed ${tested}`);

    writeFileSync(join(app, "plugin", "index.ts"), `
import { createMist } from "${name}";
import { sleep } from "${name}/util";
export const mist = createMist("tiny");
export default mist.define({ async start() { await sleep(10); } });
`);
    // As Evi's build bundles a plugin's page side
    const built = await Bun.build({
        entrypoints: [join(app, "plugin", "index.ts")], target: "browser", format: "cjs",
        external: ["@evi/api", "react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    });
    if (!built.success) problems.push(`bundling a plugin failed: ${built.logs.join("\n")}`);
    else {
        const code = await built.outputs[0].text();
        const modules = [...code.matchAll(/^\/\/ \S*node_modules\/\S+\/dist\/(\S+)$/gm)].map(m => m[1]);
        for (const unused of ["native.js", "stores.js", "bus.js", "discord.js", "testing.js", "ui.js"]) if (modules.includes(unused)) problems.push(`the bundle carries ${unused}, which the plugin doesn't import`);
        for (const unused of modules.filter(m => m.startsWith("ui/"))) problems.push(`the bundle carries ${unused}, which the plugin doesn't import`);
        // HttpError stays: mist.native rebuilds one thrown by the native side
        for (const unused of ["function fetchJson", "function isRecord"]) if (code.includes(unused)) problems.push(`the bundle carries ${unused} from util.js, which the plugin doesn't use`);
        if (!code.includes("function createMist") || !code.includes("function sleep")) problems.push("the bundle lost createMist or sleep");
    }

    writeFileSync(join(app, "plugin", "native.ts"), `
import { defineNative } from "${name}/native";
export default defineNative({ add: (a: number, b: number) => a + b });
`);
    // As Evi's build bundles a plugin's native side. Evi's review flags programs, files and Electron in native.js.
    const nativeBuilt = await Bun.build({ entrypoints: [join(app, "plugin", "native.ts")], target: "node", format: "cjs", external: ["electron"] });
    if (!nativeBuilt.success) problems.push(`bundling a native side failed: ${nativeBuilt.logs.join(" ")}`);
    else {
        const code = await nativeBuilt.outputs[0].text();
        for (const unused of ["child_process", "electron", "safeStorage", "function jsonFile"]) if (code.includes(unused)) problems.push(`the native bundle carries ${unused}, which a native side using only defineNative doesn't use`);
        if (!code.includes("function defineNative")) problems.push("the native bundle lost defineNative");
    }
} finally {
    rmSync(dir, { recursive: true, force: true });
}

if (problems.length) {
    console.error(`Installing ${pkg.name} from its tarball:\n  ${problems.join("\n  ")}`);
    process.exit(1);
}
console.log(`${pkg.name} installs from its tarball: npx mist runs, every subpath typechecks, the testing subpath runs under Node, and a plugin bundle carries only what it imports`);
