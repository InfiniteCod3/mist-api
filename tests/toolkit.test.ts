import type { NativeContext } from "@evi/api/native";
import { afterAll, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { killWithEscalation } from "../src/lifetime";
import { dataFolder, discordWindow, jsonFile, lifetime, NativeError, pathGrants, run, secrets, which, writeAtomic, writeAtomicSync } from "../src/native";
import { electron } from "./electron";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** A native context over a fresh temporary data folder; `dispose` runs its disposers as Evi does on stop */
function nativeContext(pluginId = "t-kit", dataDir?: string) {
    if (!dataDir) dirs.push(dataDir = mkdtempSync(join(tmpdir(), "mist-data-")));
    const disposers: (() => void)[] = [];
    const ctx: NativeContext = { pluginId, pluginDir: dataDir, dataDir, onBeforeRequest: () => () => { }, onDispose: fn => void disposers.push(fn) };
    return { ctx, dataDir, dispose: () => { for (const fn of disposers.splice(0).reverse()) fn(); } };
}

const waitFor = async (done: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!done()) {
        if (Date.now() > end) throw new Error("timed out waiting");
        await new Promise(resolve => setTimeout(resolve, 5));
    }
};

async function rejection(pending: Promise<unknown>) {
    try {
        await pending;
    } catch (err) {
        return err;
    }
    throw new Error("expected a rejection");
}

test("discordWindow takes Discord's main window id when it shows the app, and otherwise the first window showing the app", () => {
    const global = globalThis as { mainWindowId?: number; };
    electron.reset();
    const [, overlay, , gone, ptb, app] = [
        "file:///splash/index.html",
        "https://discord.com/overlay",
        "https://discord.com/popout",
        "https://canary.discord.com/channels/@me",
        "https://ptb.discord.com/channels/@me",
        "https://discord.com/app",
    ].map(url => electron.addWindow({ url }));
    gone.destroy();
    delete global.mainWindowId;
    expect(discordWindow()?.id).toBe(ptb.id);
    global.mainWindowId = app.id;
    expect(discordWindow()?.id).toBe(app.id);
    global.mainWindowId = overlay.id;
    expect(discordWindow()?.id).toBe(ptb.id);
    ptb.destroy();
    app.destroy();
    expect(discordWindow()).toBeUndefined();
    delete global.mainWindowId;
    electron.reset();
});

test("a lifetime clears its timers, destroys its windows and aborts its signal when the native side stops, and refuses use after", async () => {
    const { ctx, dispose } = nativeContext();
    const life = lifetime(ctx);
    let ticks = 0, fired = 0, early = 0;
    life.interval(() => ticks++, 5);
    life.timeout(() => fired++, 40);
    life.timeout(() => early++, 1)();
    const win = { destroyed: false, isDestroyed() { return this.destroyed; }, destroy() { this.destroyed = true; } };
    expect(life.window(win)).toBe(win);
    await waitFor(() => ticks >= 2);
    dispose();
    const ticksAtStop = ticks;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect([ticks, fired, early]).toEqual([ticksAtStop, 0, 0]);
    expect(win.destroyed).toBe(true);
    expect(life.signal.aborted).toBe(true);
    expect(() => life.interval(() => { }, 5)).toThrow(NativeError);
    expect(() => life.spawn(process.execPath)).toThrow(/stopped/);
});

test("a lifetime kills its child processes when the native side stops", async () => {
    const { ctx, dispose } = nativeContext();
    const life = lifetime(ctx);
    const child = life.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    await new Promise(resolve => child.once("spawn", resolve));
    let exited = false;
    child.once("exit", () => { exited = true; });
    dispose();
    await waitFor(() => exited);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

test("a child that outlives SIGTERM gets SIGKILL after the grace period", async () => {
    const sent: string[] = [];
    const child = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        signalCode: null as string | null,
        kill(signal: string) { sent.push(signal); return true; },
    });
    killWithEscalation(child as unknown as ChildProcess, 20);
    expect(sent).toEqual(["SIGTERM"]);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(sent).toEqual(["SIGTERM", "SIGKILL"]);

    const polite = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null, kill(signal: string) { sent.push(`polite ${signal}`); return true; } });
    killWithEscalation(polite as unknown as ChildProcess, 20);
    polite.exitCode = 0;
    polite.emit("exit", 0, null);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(sent.filter(s => s.startsWith("polite"))).toEqual(["polite SIGTERM"]);
});

test("run collects output and the exit code, passes input, and kills the program on timeout, abort or too much output", async () => {
    const node = process.execPath;
    const ok = await run(node, ["-e", "process.stdin.pipe(process.stdout); process.stderr.write('warn'); process.on('exit', () => process.exitCode = 3)"], { input: "hello" });
    expect(ok).toEqual({ code: 3, signal: null, stdout: "hello", stderr: "warn" });

    const slow = ["-e", "setTimeout(() => {}, 30000)"];
    const started = Date.now();
    expect(await rejection(run(node, slow, { timeout: 100 }))).toMatchObject({ code: "timeout" });
    const controller = new AbortController();
    const aborted = run(node, slow, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect(await rejection(aborted)).toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(10_000);

    expect(await rejection(run(node, ["-e", "process.stdout.write('x'.repeat(5000))"], { maxBytes: 100 }))).toMatchObject({ code: "too-large" });
    expect(await rejection(run(join(tmpdir(), "no-such-program-mist")))).toMatchObject({ code: "ENOENT" });
});

test("which finds a program on PATH, with PATHEXT on Windows, and answers null for one that isn't there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mist-path-"));
    dirs.push(dir);
    const windows = process.platform === "win32";
    const name = "mist-tool";
    const file = join(dir, windows ? `${name}.cmd` : name);
    writeFileSync(file, windows ? "@echo off" : "#!/bin/sh\n", { mode: 0o755 });
    mkdirSync(join(dir, `${name}-folder${windows ? ".cmd" : ""}`));
    const env = { PATH: [join(dir, "missing"), dir].join(windows ? ";" : ":"), PATHEXT: ".EXE;.CMD" };
    expect(await which(name, env)).toBe(file);
    expect(await which("mist-tool-folder", env)).toBeNull();
    expect(await which("not-a-program", env)).toBeNull();
    expect(await which(file, env)).toBe(file);
    expect(await which(basename(process.execPath, windows ? ".exe" : ""), { ...env, PATH: dirname(process.execPath) })).toBe(process.execPath);
});

test("jsonFile lives in the plugin's own folder, writes after the debounce, and flushes a pending write when the native side stops", async () => {
    const { ctx, dataDir, dispose } = nativeContext("t-json");
    const prefs = jsonFile(ctx, "prefs", { initial: { volume: 50 }, debounceMs: 20 });
    expect(prefs.path).toBe(join(dataDir, "plugin-data", "t-json", "prefs.json"));
    expect(dataFolder(ctx)).toBe(dirname(prefs.path));
    expect(prefs.get()).toEqual({ volume: 50 });
    expect(existsSync(prefs.path)).toBe(false);

    prefs.set({ volume: 60 });
    prefs.set(p => ({ volume: p.volume + 1 }));
    expect(prefs.get()).toEqual({ volume: 61 });
    await waitFor(() => existsSync(prefs.path));
    expect(JSON.parse(readFileSync(prefs.path, "utf8"))).toEqual({ volume: 61 });

    const slow = jsonFile(ctx, "slow", { initial: [] as number[], debounceMs: 60_000 });
    slow.set([1, 2]);
    dispose();
    expect(JSON.parse(readFileSync(slow.path, "utf8"))).toEqual([1, 2]);

    const reopened = jsonFile(nativeContext("t-json", dataDir).ctx, "prefs", { initial: { volume: 0 } });
    expect(reopened.get()).toEqual({ volume: 61 });
    expect(readdirSync(dirname(prefs.path)).filter(f => f.endsWith(".tmp"))).toEqual([]);
});

test("jsonFile's flush writes the last value even with writes racing, and leaves no temporary files", async () => {
    const { ctx } = nativeContext("t-race");
    const file = jsonFile(ctx, "counter", { initial: 0, debounceMs: 0 });
    const flushes: Promise<void>[] = [];
    for (let i = 1; i <= 50; i++) {
        file.set(i);
        flushes.push(file.flush());
    }
    await Promise.all(flushes);
    await file.flush();
    expect(JSON.parse(readFileSync(file.path, "utf8"))).toBe(50);
    expect(readdirSync(dirname(file.path)).filter(f => f.endsWith(".tmp"))).toEqual([]);
});

test("jsonFile keeps a file it can't parse as .bad and starts from initial, and refuses a value over maxBytes or a bad name", () => {
    const { ctx } = nativeContext("t-bad");
    const folder = dataFolder(ctx);
    writeFileSync(join(folder, "broken.json"), "{ not json");
    writeFileSync(join(folder, "wrong.json"), "[1, 2]");
    const broken = jsonFile(ctx, "broken", { initial: { ok: true } });
    expect(broken.get()).toEqual({ ok: true });
    expect(readFileSync(join(folder, "broken.json.bad"), "utf8")).toBe("{ not json");
    expect(jsonFile(ctx, "wrong", { initial: {} as Record<string, number> }).get()).toEqual({});
    expect(jsonFile(ctx, "parsed", { initial: 0, parse: raw => { if (typeof raw !== "number") throw new Error("not a number"); return raw; } }).get()).toBe(0);

    const small = jsonFile(ctx, "small", { initial: "", maxBytes: 10 });
    expect(() => small.set("a".repeat(20))).toThrow(RangeError);
    expect(() => small.set(undefined as never)).toThrow(new TypeError("jsonFile: small.json can't be stored as JSON (got undefined)"));
    expect(() => small.set(1n as never)).toThrow(/jsonFile: small\.json can't be stored as JSON/);
    expect(small.get()).toBe("");
    for (const name of ["../escape", "a/b", "", "mist-secrets", ".hidden"]) {
        expect(() => jsonFile(ctx, name, { initial: 0 })).toThrow(TypeError);
        expect(() => jsonFile(ctx, name, { initial: 0 })).toThrow(/bad file name/);
    }
    expect(() => dataFolder({ ...ctx, pluginId: "../other" })).toThrow(TypeError);
});

test("jsonFile leaves a file it can't read alone, and get and set throw until it can be read, so no write replaces it", () => {
    const { ctx, dataDir, dispose } = nativeContext("t-unreadable");
    const folder = dataFolder(ctx);
    const kept = JSON.stringify({ notes: "x".repeat(50) });
    writeFileSync(join(folder, "big.json"), kept);
    const big = jsonFile(ctx, "big", { initial: {}, maxBytes: 20 });
    expect(() => big.get()).toThrow(expect.objectContaining({ name: "NativeError", code: "file-unreadable" }));
    expect(() => big.set({})).toThrow(NativeError);
    dispose();
    expect(readFileSync(join(folder, "big.json"), "utf8")).toBe(kept);
    expect(existsSync(join(folder, "big.json.bad"))).toBe(false);

    // A folder where the file should be fails the read with EISDIR, as a locked file fails it with EBUSY
    mkdirSync(join(folder, "locked.json"));
    const locked = jsonFile(nativeContext("t-unreadable", dataDir).ctx, "locked", { initial: 1 });
    expect(() => locked.get()).toThrow("locked.json couldn't be read (EISDIR)");
    rmdirSync(join(folder, "locked.json"));
    expect(locked.get()).toBe(1);
    locked.set(2);
    expect(locked.get()).toBe(2);
});

test("helpers for one file in a native run share it, so two of them don't overwrite each other's writes", () => {
    const { ctx, dataDir, dispose } = nativeContext("t-shared");
    secrets(ctx).set("a", "1");
    secrets(ctx).set("b", "2");
    const counter = jsonFile(ctx, "counter", { initial: 0, debounceMs: 60_000 });
    expect(jsonFile(ctx, "counter", { initial: 0 })).toBe(counter);
    jsonFile(ctx, "counter", { initial: 0 }).set(n => n + 1);
    counter.set(n => n + 1);
    dispose();

    const next = nativeContext("t-shared", dataDir).ctx;
    expect([secrets(next).get("a"), secrets(next).get("b")]).toEqual(["1", "2"]);
    expect(jsonFile(next, "counter", { initial: 0 }).get()).toBe(2);
});

test("when Discord quits, pending writes are flushed and lifetime children killed; a stopped run's quit listeners are gone", async () => {
    const listeners = () => [electron.module.app.listenerCount("will-quit"), process.listenerCount("exit")];
    const before = listeners();
    const { ctx, dispose } = nativeContext("t-quit");
    const prefs = jsonFile(ctx, "prefs", { initial: 0, debounceMs: 60_000 });
    prefs.set(5);
    secrets(ctx).set("token", "t");
    const child = lifetime(ctx).spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    await new Promise(resolve => child.once("spawn", resolve));
    let exited = false;
    child.once("exit", () => { exited = true; });
    expect(listeners()).toEqual([before[0] + 1, before[1] + 1]);

    electron.module.app.emit("will-quit");
    expect(JSON.parse(readFileSync(prefs.path, "utf8"))).toBe(5);
    expect(Object.keys(JSON.parse(readFileSync(join(dataFolder(ctx), "mist-secrets.json"), "utf8")))).toEqual(["token"]);
    await waitFor(() => exited);

    dispose();
    expect(listeners()).toEqual(before);
});

test("secrets are stored encrypted in the plugin's folder and read back; they report plaintext fallback and refuse without encryption", async () => {
    const { ctx, dataDir, dispose } = nativeContext("t-secrets");
    const vault = secrets(ctx);
    expect(vault.encrypted).toBe(true);
    vault.set("apiKey", "k-very-secret");
    expect(vault.get("apiKey")).toBe("k-very-secret");
    expect(vault.get("missing")).toBeUndefined();
    dispose();
    const file = join(dataDir, "plugin-data", "t-secrets", "mist-secrets.json");
    expect(readFileSync(file, "utf8")).not.toContain("k-very-secret");
    const restarted = nativeContext("t-secrets", dataDir);
    const again = secrets(restarted.ctx);
    expect(again.get("apiKey")).toBe("k-very-secret");

    expect(again.delete("apiKey")).toBe(true);
    expect(again.delete("apiKey")).toBe(false);
    expect(again.get("constructor")).toBeUndefined();
    again.set("__proto__", "x");
    expect(again.get("__proto__")).toBe("x");
    expect(() => again.set("../x", "x")).toThrow(/bad secret name/);

    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
        electron.storageBackend = "basic_text";
        expect(again.encrypted).toBe(false);
        electron.storageBackend = "gnome_libsecret";
        expect(again.encrypted).toBe(true);
    } finally {
        Object.defineProperty(process, "platform", platform);
    }
    electron.encryptionAvailable = false;
    try {
        expect(again.encrypted).toBe(false);
        expect(() => again.set("apiKey", "x")).toThrow(expect.objectContaining({ code: "secrets-unavailable" }));
    } finally {
        electron.encryptionAvailable = true;
    }
    restarted.dispose();
});

test("path grants hand out opaque handles for what the person picked, resolve only on the native side, and stay inside a folder", async () => {
    const { ctx, dataDir, dispose } = nativeContext("t-grants");
    electron.reset();
    const main = electron.addWindow({ url: "https://discord.com/app" });
    const grants = pathGrants(ctx);
    const picked = join(dataDir, "picked");

    electron.dialogAnswers.open = { canceled: false, filePaths: [picked] };
    const folder = await grants.pickFolder({ title: "Choose a folder" });
    expect(folder).toMatch(/^grant:[0-9a-f-]{36}$/);
    expect(folder).not.toContain(picked);
    expect(electron.dialogCalls.at(-1)).toMatchObject({ kind: "open", parent: { id: main.id }, options: { title: "Choose a folder", properties: ["openDirectory"] } });
    expect(grants.resolveGrant(folder)).toBe(picked);
    expect(grants.resolveGrant(folder, "notes", "a.txt")).toBe(join(picked, "notes", "a.txt"));
    for (const escape of [[".."], ["notes", "..", "..", "x"], [dataDir]]) {
        expect(() => grants.resolveGrant(folder, ...escape)).toThrow(expect.objectContaining({ code: "outside-grant" }));
    }

    electron.dialogAnswers.open = { canceled: false, filePaths: [join(picked, "one.txt")] };
    const file = await grants.pickFile();
    expect(electron.dialogCalls.at(-1)?.options.properties).toEqual(["openFile"]);
    expect(() => grants.resolveGrant(file, "x")).toThrow(expect.objectContaining({ code: "outside-grant" }));

    electron.dialogAnswers.open = { canceled: true, filePaths: [] };
    expect(await grants.pickFile()).toBeNull();
    for (const forged of [picked, "grant:00000000-0000-0000-0000-000000000000", 42, undefined]) {
        expect(() => grants.resolveGrant(forged)).toThrow(expect.objectContaining({ code: "unknown-grant" }));
    }

    dispose();
    const restarted = nativeContext("t-grants", dataDir);
    const later = pathGrants(restarted.ctx);
    expect(later.resolveGrant(file)).toBe(join(picked, "one.txt"));
    expect(later.revokeGrant(file)).toBe(true);
    expect(() => later.resolveGrant(file)).toThrow(expect.objectContaining({ code: "unknown-grant" }));
    restarted.dispose();
    electron.reset();
});

/** What `log` printed to console.error while `fn` ran */
async function loggedErrors(fn: () => Promise<void>) {
    const printed: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
    try {
        await fn();
    } finally {
        console.error = original;
    }
    return printed;
}

test("a lifetime timer that throws is logged and doesn't stop the others", async () => {
    const { ctx, dispose } = nativeContext();
    const life = lifetime(ctx);
    let ticks = 0;
    const printed = await loggedErrors(async () => {
        life.interval(() => { throw new Error("tick broke"); }, 5);
        life.timeout(() => { throw new Error("timeout broke"); }, 1);
        life.interval(() => ticks++, 5);
        await waitFor(() => ticks >= 3);
        dispose();
    });
    expect(printed.some(line => line.includes("A lifetime interval threw:") && line.includes("tick broke"))).toBe(true);
    expect(printed.some(line => line.includes("A lifetime timeout threw:") && line.includes("timeout broke"))).toBe(true);
});

test("run settles on timeout or abort even while a grandchild keeps the output pipes open", async () => {
    // The grandchild inherits the pipes and outlives both its parent and the test's deadline
    const spawnsGrandchild = (parent: string) => ["-e", `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 6000)"], { stdio: "inherit" }); ${parent}`];
    const started = Date.now();
    expect(await rejection(run(process.execPath, spawnsGrandchild("setInterval(() => {}, 1000)"), { timeout: 300 }))).toMatchObject({ code: "timeout" });

    const controller = new AbortController();
    const exitsFirst = run(process.execPath, spawnsGrandchild(""));
    setTimeout(() => controller.abort(), 800);
    const aborted = run(process.execPath, spawnsGrandchild(""), { signal: controller.signal });
    expect(await rejection(aborted)).toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(4000);
    // Without a failure, run waits for the pipes to close, so the output is complete
    expect(await exitsFirst).toMatchObject({ code: 0 });
}, 15_000);

test("a .cmd or .bat on Windows needs a shell, and run and lifetime.spawn say so instead of failing with EINVAL", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const { ctx, dispose } = nativeContext();
    const life = lifetime(ctx);
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
        for (const file of ["C:\\tools\\build.cmd", "C:\\tools\\OLD.BAT"]) {
            expect(await rejection(run(file))).toMatchObject({ name: "NativeError", code: "needs-shell", data: { file } });
            expect(() => life.spawn(file)).toThrow(expect.objectContaining({ code: "needs-shell" }));
        }
    } finally {
        Object.defineProperty(process, "platform", platform);
        dispose();
    }
});

test.skipIf(process.platform !== "win32")("which reads PATH and PATHEXT whatever their case, as Windows does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mist-pathext-"));
    dirs.push(dir);
    const file = join(dir, "mist-case.cmd");
    writeFileSync(file, "@echo off");
    expect(await which("mist-case", { Path: dir, PathExt: ".EXE;.CMD" })).toBe(file);
    expect(await which("mist-case", { Path: dir, pathext: ".EXE" })).toBeNull();
});

test("jsonFile that can't move an unparseable file aside leaves it alone and refuses to replace it", () => {
    const { ctx, dataDir, dispose } = nativeContext("t-stuck");
    const folder = dataFolder(ctx);
    writeFileSync(join(folder, "notes.json"), "{ half written");
    // A folder in the way of notes.json.bad makes the rename fail, as a lock or missing permission does
    mkdirSync(join(folder, "notes.json.bad", "inside"), { recursive: true });
    const notes = jsonFile(ctx, "notes", { initial: { list: [] as string[] }, debounceMs: 0 });
    expect(() => notes.get()).toThrow(expect.objectContaining({ code: "file-unreadable" }));
    expect(() => notes.set({ list: ["new"] })).toThrow(NativeError);
    dispose();
    expect(readFileSync(join(folder, "notes.json"), "utf8")).toBe("{ half written");

    rmSync(join(folder, "notes.json.bad"), { recursive: true });
    const later = jsonFile(nativeContext("t-stuck", dataDir).ctx, "notes", { initial: { list: [] as string[] } });
    expect(later.get()).toEqual({ list: [] });
    expect(readFileSync(join(folder, "notes.json.bad"), "utf8")).toBe("{ half written");
});

test("writeAtomicSync is exported for a plugin's files, and replaces the file whole", () => {
    const dir = mkdtempSync(join(tmpdir(), "mist-atomic-"));
    dirs.push(dir);
    const path = join(dir, "state.json");
    writeAtomicSync(path, "{\"v\":1}");
    writeAtomicSync(path, "{\"v\":2}");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ v: 2 });
    expect(readdirSync(dir)).toEqual(["state.json"]);
});

test("writeAtomic and writeAtomicSync take bytes as well as text, and a failed write leaves no temporary file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mist-atomic-"));
    dirs.push(dir);
    const path = join(dir, "blob.bin");
    await writeAtomic(path, "first");
    expect(readFileSync(path, "utf8")).toBe("first");
    await writeAtomic(path, Uint8Array.of(1, 2, 3));
    expect([...readFileSync(path)]).toEqual([1, 2, 3]);
    writeAtomicSync(path, Uint8Array.of(4, 5));
    expect([...readFileSync(path)]).toEqual([4, 5]);

    // Renaming over a folder fails: the temporary file is removed and the error comes through
    const folder = join(dir, "folder");
    mkdirSync(folder);
    writeFileSync(join(folder, "keep"), "");
    expect(await writeAtomic(folder, "x").then(() => null, err => err)).toBeInstanceOf(Error);
    expect(() => writeAtomicSync(folder, "x")).toThrow();
    expect(readdirSync(dir).sort()).toEqual(["blob.bin", "folder"]);
});

test("a timing option that isn't a number is a TypeError, and one out of range, past 2^31 - 1 ms included, a RangeError", async () => {
    const { ctx } = nativeContext("t-numbers");
    const scope = lifetime(ctx);
    for (const bad of [NaN, "5", undefined]) expect(() => scope.timeout(() => { }, bad as number)).toThrow(TypeError);
    for (const bad of [-1, Infinity, 2 ** 31]) expect(() => scope.interval(() => { }, bad)).toThrow(RangeError);
    expect(() => scope.timeout(() => { }, 2 ** 31)).toThrow("lifetime.timeout: ms must be a finite number from 0 to 2147483647, got 2147483648");
    scope.timeout(() => { }, 2 ** 31 - 1)();

    expect(() => jsonFile(ctx, "n", { initial: 0, debounceMs: "1" as unknown as number })).toThrow(TypeError);
    expect(() => jsonFile(ctx, "n", { initial: 0, debounceMs: 2 ** 31 })).toThrow(RangeError);
    expect(() => jsonFile(ctx, "n", { initial: 0, maxBytes: 1.5 })).toThrow("jsonFile: maxBytes must be a whole number from 1, got 1.5");
    expect(await rejection(run("node", [], { timeout: 2 ** 31 }))).toBeInstanceOf(RangeError);
});
