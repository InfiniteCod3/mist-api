#!/usr/bin/env node
/**
 * mist: debugs Evi plugins built on mist-api, over Discord's debugging port.
 * Built to dist/bin/mist.js, which runs on Node 22 or later; this source runs on Node 22.18+ or Bun.
 * Never bundled into a plugin.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { callOn, capability, CdpError, concerns, connect, type Connection, evaluate, releaseGroup } from "./cdp.ts";

const USAGE = `mist <command> [options]

  status                      every mist plugin: running, errors, patch and lookup health
  logs <id> [-f]              the plugin's page log; -f keeps printing new lines
  calls <id>                  its native calls: arguments, result or error, time taken
  native-logs <id>            what its native side logged and was called with
  values <id>                 the values it exposes, and its settings
  call <id> <method> [args]   calls a native method; each arg is JSON, or a plain string
  patches [id]                Evi's patch and lookup diagnosis, problems first
  eval <expression>           evaluates in Discord's page and prints the result
  restart                     restarts Discord with --remote-debugging-port

  --port <n>   debugging port (default 9222)
  -n <count>   how many records (default 50)
  --json       prints raw JSON
  --dry-run    restart: prints what it would run`;

interface Options { port: number; count: number; json: boolean; follow: boolean; dryRun: boolean; }

function parse(argv: string[]): { positional: string[]; options: Options; } {
    const options: Options = { port: 9222, count: 50, json: false, follow: false, dryRun: false };
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const next = argv[++i];
            if (next === undefined) throw new CdpError(`${arg} needs a value`);
            return next;
        };
        if (arg === "--port") options.port = Number(value());
        else if (arg === "-n") options.count = Number(value());
        else if (arg === "--json") options.json = true;
        else if (arg === "-f" || arg === "--follow") options.follow = true;
        else if (arg === "--dry-run") options.dryRun = true;
        else positional.push(arg);
    }
    if (!Number.isInteger(options.port) || options.port < 1) throw new CdpError("--port must be a port number");
    if (!Number.isInteger(options.count) || options.count < 1) throw new CdpError("-n must be a positive number");
    return { positional, options };
}

const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false }) + "." + String(at % 1000).padStart(3, "0");
const show = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
const clip = (text: string, max = 300) => text.length > max ? `${text.slice(0, max)}…` : text;
/** Quiet methods' call counts, as in "poll 12". A copy that sends no counts shows none. */
const quietCounts = (quiet: Record<string, number> | undefined) => Object.entries(quiet ?? {}).map(([method, n]) => `${method} ${n}`).join(", ");

interface LogRecord { at: number; level: string; args: unknown[]; }
type Outcome = { state: "pending"; } | { state: "ok"; ms: number; result: unknown; } | { state: "error"; ms: number; message: string; };
interface CallRecord { method: string; at: number; args: unknown[]; outcome: Outcome; }

const logLine = (r: LogRecord) => `${time(r.at)} ${r.level.padEnd(5)} ${r.args.map(show).join(" ")}`;
function callLine(r: CallRecord) {
    const head = `${time(r.at)} ${r.method}(${clip(r.args.map(a => JSON.stringify(a)).join(", "))})`;
    switch (r.outcome.state) {
        case "pending": return `${head} … pending`;
        case "ok": return `${head} ok ${Math.round(r.outcome.ms)} ms -> ${clip(JSON.stringify(r.outcome.result) ?? "undefined")}`;
        case "error": return `${head} FAILED ${Math.round(r.outcome.ms)} ms: ${r.outcome.message}`;
    }
}

/** Runs `fn` on the plugin's capability; `this` inside `fn` is the capability */
async function onCapability<T>(c: Connection, plugin: string, fn: string, args: unknown[] = []): Promise<T> {
    const group = `mist-cli-${Date.now()}`;
    try {
        return await callOn<T>(c.send, await capability(c.send, plugin, group), fn, args);
    } finally {
        await releaseGroup(c.send, group);
    }
}

function print(value: unknown, json: boolean, lines?: (value: any) => string[]) {
    if (json || !lines) return console.log(JSON.stringify(value, null, 2));
    const out = lines(value);
    console.log(out.length ? out.join("\n") : "Nothing recorded yet.");
}

function statusLines(all: any[]): string[] {
    if (!all.length) return ["No mist-api plugin has registered on this page."];
    return all.flatMap(p => {
        const s = p.state;
        const head = s.error
            ? `${p.id}  (state unreadable: ${s.error})`
            : `${p.id}  ${s.running ? "running" : "stopped"}  mist ${p.mistVersion}  native: ${s.native}${s.debug ? " (debug open)" : ""}  errors: ${s.errors.calls} calls, ${s.errors.logs} logs`;
        const out = [head];
        if (!s.error && quietCounts(s.quiet)) out.push(`  quiet calls, counted and not kept: ${quietCounts(s.quiet)}`);
        if (p.startError) out.push(`  start error: ${p.startError}`);
        const r = p.registry;
        if (r && r.registered > 1) out.push(`  registry: registered ${r.registered} times, ${r.replaced} replacing another handle (a hot reload replaces one)`);
        for (const concern of p.concerns ?? []) out.push(`  WARNING: ${concern}`);
        const health = (h: Record<string, number>) => Object.entries(h).map(([k, v]) => `${v} ${k}`).join(", ") || "none";
        if (p.patches?.error) out.push(`  patches: ${p.patches.error}`);
        else if (p.patches) out.push(`  patches: ${health(p.patches.health)}`, ...p.patches.problems.map((x: any) => `    #${x.index} ${x.health} find ${x.find}${x.errors.length ? `: ${x.errors.join("; ")}` : ""}`));
        if (p.lookups?.error) out.push(`  lookups: ${p.lookups.error}`);
        else if (p.lookups) out.push(`  lookups: ${health(p.lookups.health)}`, ...p.lookups.problems.map((x: any) => `    ${x.health} ${x.target}`));
        return out;
    });
}

// $mistOnDemand: the mark onDemand() in src/patches.ts sets on a patch whose code Discord downloads later
const PATCHES = (plugin: string | undefined) => `(() => {
    const id = ${JSON.stringify(plugin ?? null)};
    const rank = h => ["broken", "failed", "partial", "ambiguous", "missing"].includes(h) ? 0 : h === "waiting" ? 1 : 2;
    const patches = Evi.diagnosePatches().filter(p => !id || p.plugin === id)
        .map(p => ({ plugin: p.plugin, index: p.index, health: p.health === "broken" && p.patch.$mistOnDemand === true ? "waiting" : p.health, find: String(p.patch.find), modules: p.modules, candidates: p.candidates, errors: p.errors }));
    const lookups = Evi.diagnoseLookups(id ?? undefined)
        .map(l => ({ plugin: l.plugin, target: l.target, health: l.health, candidates: l.candidates }));
    return { patches: patches.sort((a, b) => rank(a.health) - rank(b.health)), lookups: lookups.sort((a, b) => rank(a.health) - rank(b.health)) };
})()`;

function patchLines({ patches, lookups }: { patches: any[]; lookups: any[]; }): string[] {
    return [
        `${patches.length} patches`,
        ...patches.map(p => `  ${p.health.padEnd(9)} ${p.plugin} #${p.index} find ${clip(p.find, 120)}${p.modules.length ? `  modules ${p.modules.join(",")}` : ""}${p.errors.length ? `\n            ${p.errors.join("\n            ")}` : ""}`),
        `${lookups.length} lookups`,
        ...lookups.map(l => `  ${l.health.padEnd(9)} ${l.plugin} ${l.target}${l.candidates.length ? `  candidates ${l.candidates.join(",")}` : ""}`),
    ];
}

/** A CLI argument as a call argument: JSON when it parses, the plain string otherwise */
const argument = (raw: string): unknown => {
    try { return JSON.parse(raw); } catch { return raw; }
};

async function follow(c: Connection, plugin: string, count: number) {
    const seen = new Set<string>();
    for (; ;) {
        const records = await onCapability<LogRecord[]>(c, plugin, "function (n) { return this.logs(n); }", [count]);
        const fresh = records.filter(r => !seen.has(JSON.stringify(r)));
        for (const r of fresh) console.log(logLine(r));
        seen.clear();
        for (const r of records) seen.add(JSON.stringify(r));
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

function restart(port: number, dryRun: boolean) {
    const flag = `--remote-debugging-port=${port}`;
    if (process.platform !== "win32") {
        const command = process.platform === "darwin"
            ? `osascript -e 'quit app "Discord"'; open -a Discord --args ${flag}`
            : `pkill -x Discord; discord ${flag} &`;
        console.log(`Run this to restart Discord with its debugging port:\n  ${command}`);
        return;
    }
    const update = join(process.env.LOCALAPPDATA ?? "", "Discord", "Update.exe");
    if (!existsSync(update)) throw new CdpError(`No Discord installer at ${update}`);
    const kill = ["taskkill", ["/IM", "Discord.exe", "/F"]] as const;
    const start = [update, ["--processStart", "Discord.exe", "--process-start-args", flag]] as const;
    if (dryRun) {
        for (const [cmd, args] of [kill, start]) console.log([cmd, ...args].map(a => a.includes(" ") ? `"${a}"` : a).join(" "));
        return;
    }
    const killer = spawn(kill[0], kill[1], { stdio: "ignore" });
    killer.on("exit", () => {
        // Discord takes a moment to let go of its single-instance lock
        setTimeout(() => {
            spawn(start[0], start[1], { detached: true, stdio: "ignore" }).unref();
            console.log(`Discord restarts with ${flag}`);
        }, 1500);
    });
}

async function main() {
    const { positional: [command, ...rest], options } = parse(process.argv.slice(2));
    if (!command || command === "help" || command === "--help" || command === "-h") {
        console.log(USAGE);
        return;
    }
    if (command === "restart") return restart(options.port, options.dryRun);

    const needId = () => {
        if (!rest[0]) throw new CdpError(`mist ${command} needs a plugin id (mist status lists them)`);
        return rest[0];
    };
    const c = await connect(options.port);
    try {
        switch (command) {
            case "status": {
                const all = await evaluate<any[] | null>(c.send, `globalThis.Mist ? Mist.status() : null`);
                if (all === null) throw new CdpError("No mist-api plugin has loaded on this page");
                return print(all, options.json, statusLines);
            }
            case "logs": {
                const id = needId();
                if (options.follow) return await follow(c, id, options.count);
                return print(await onCapability(c, id, "function (n) { return this.logs(n); }", [options.count]), options.json, (r: LogRecord[]) => r.map(logLine));
            }
            case "calls": {
                const id = needId();
                return print(await onCapability(c, id, "function (n) { return this.calls(n); }", [options.count]), options.json, (r: CallRecord[]) => r.map(callLine));
            }
            case "native-logs": {
                const id = needId();
                const answer = await onCapability<{ full: boolean; calls: CallRecord[]; logs: LogRecord[]; quiet?: Record<string, number>; } | null>(c, id, "function (n) { return this.nativeLogs(n); }", [options.count]);
                if (!answer) throw new CdpError(`${id} has no native side made with defineNative, or isn't running`);
                if (!answer.full) console.error("Values are shown as type and size only: Discord's main process has no --remote-debugging-port.");
                return print(answer, options.json, a => [
                    "calls", ...a.calls.map(callLine),
                    ...quietCounts(a.quiet) ? [`quiet calls, counted and not kept: ${quietCounts(a.quiet)}`] : [],
                    "logs", ...a.logs.map(logLine),
                ]);
            }
            case "values": {
                const id = needId();
                const answer = await onCapability(c, id, "function () { return { values: this.values(), settings: this.settings() }; }");
                return print(answer, true);
            }
            case "call": {
                const id = needId();
                const method = rest[1];
                if (!method) throw new CdpError("mist call needs a method name");
                // The arguments may hold a secret: they go only to a handle the registry has no doubt about
                const doubts = await concerns(c.send, id);
                if (doubts === null) console.error(`The page's registry keeps no history, so mist can't check that ${id}'s handle is the plugin's own.`);
                else if (doubts.length) throw new CdpError(`mist call sends nothing to ${id}:\n  ${doubts.join("\n  ")}\nmist status shows the registry's history. Restart Discord to start a fresh registry.`);
                const result = await onCapability(c, id, "function (method, args) { return this.call(method, ...args); }", [method, rest.slice(2).map(argument)]);
                return print(result, true);
            }
            case "patches":
                return print(await evaluate(c.send, PATCHES(rest[0])), options.json, patchLines);
            case "eval": {
                if (!rest.length) throw new CdpError("mist eval needs an expression");
                return print(await evaluate(c.send, rest.join(" ")), true);
            }
            default:
                throw new CdpError(`Unknown command ${command}\n\n${USAGE}`);
        }
    } finally {
        if (!options.follow) c.close();
    }
}

main().catch(err => {
    console.error(err instanceof CdpError ? err.message : err);
    process.exitCode = 1;
});
