#!/usr/bin/env node
/**
 * mist: debugs Evi plugins built on mist-api, over Discord's debugging port.
 * Built to dist/bin/mist.js, which runs on Node 22 or later; this source runs on Node 22.18+ or Bun.
 * Never bundled into a plugin.
 */
import { readFileSync } from "node:fs";

import { callCapability, CliError, concerns, connect, type Connection, evaluate } from "./cdp.ts";
import { devLines, watchDev } from "./dev.ts";
import { errorLines, type ErrorRecord, watchErrors } from "./errors.ts";
import { type FluxBatch, watchFlux } from "./flux.ts";
import { errorText, time, watchEndedMessage } from "./format.ts";
import { inspect, inspectLines } from "./inspect.ts";
import { checkLeakTarget, findLeaks, leakLines } from "./leaks.ts";
import { type CallRecord, callLine, followLogs, logLine, type LogRecord, readLogs } from "./logs.ts";
import { bumpLines, bumpManifestDir, fixLines, fixManifestDir } from "./manifest.ts";
import { moduleLines, readModule } from "./module.ts";
import { DISPLAY, RECORDED, WATCH_TTL_MS } from "./page.ts";
import { patchHealth, patchLines, readPatches } from "./patches.ts";
import { perfLines, readPerf } from "./perf.ts";
import { reactLines, readReact } from "./react.ts";
import { restart } from "./restart.ts";
import { quietCounts, readStatus, statusLines } from "./status.ts";
import { callStore, listStore, type StoreMethods } from "./store.ts";
import { waitForPlugin, waitLine } from "./wait.ts";

interface Options {
    help: boolean;
    version: boolean;
    port: number;
    count: number;
    json: boolean;
    follow: boolean;
    dryRun: boolean;
    full: boolean;
    depth: number | null;
    all: boolean;
    diff: boolean;
    write: boolean;
    cycles: number;
    yes: boolean;
    notes: Record<string, string[]>;
    wait: string | null;
    timeout: number;
}

type Flag = (options: Options, value: () => string) => void;
const FLAGS: Record<string, Flag> = {
    "-h": options => { options.help = true; },
    "--help": options => { options.help = true; },
    "-v": options => { options.version = true; },
    "--version": options => { options.version = true; },
    "--port": (options, value) => { options.port = Number(value()); },
    "-n": (options, value) => { options.count = Number(value()); },
    "--json": options => { options.json = true; },
    "-f": options => { options.follow = true; },
    "--follow": options => { options.follow = true; },
    "--dry-run": options => { options.dryRun = true; },
    "--full": options => { options.full = true; },
    "--depth": (options, value) => { options.depth = Number(value()); },
    "--all": options => { options.all = true; },
    "--diff": options => { options.diff = true; },
    "--write": options => { options.write = true; },
    "--yes": options => { options.yes = true; },
    "--cycles": (options, value) => { options.cycles = Number(value()); },
    "--wait": (options, value) => { options.wait = value(); },
    "--timeout": (options, value) => { options.timeout = Number(value()); },
};

/** A word that starts with - and a letter is an option; -1 or - alone is an argument */
const isOption = (arg: string) => /^--?[A-Za-z]/.test(arg);

function parse(argv: string[]): { positional: string[]; options: Options; } {
    const options: Options = {
        help: false,
        version: false,
        port: 9222,
        count: 50,
        json: false,
        follow: false,
        dryRun: false,
        full: false,
        depth: null,
        all: false,
        diff: false,
        write: false,
        cycles: 3,
        yes: false,
        notes: {},
        wait: null,
        timeout: 60,
    };
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--") {
            positional.push(...argv.slice(i + 1));
            break;
        }
        const value = () => {
            const next = argv[++i];
            if (next === undefined) throw new CliError(`${arg} needs a value`);
            return next;
        };
        if (!isOption(arg)) positional.push(arg);
        else if (Object.hasOwn(FLAGS, arg)) FLAGS[arg](options, value);
        else if (arg === "--note" || arg.startsWith("--note-")) (options.notes[arg === "--note" ? "en" : arg.slice(7)] ??= []).push(value());
        else throw new CliError(`Unknown option ${arg}. Run "mist help" for options, or use "--" before positional arguments.`);
    }
    if (!(options.timeout > 0)) throw new CliError("--timeout must be a number of seconds above 0");
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new CliError("--port must be a whole number from 1 to 65535");
    if (!Number.isInteger(options.count) || options.count < 1) throw new CliError("-n must be a whole number from 1");
    if (options.depth !== null && (!Number.isInteger(options.depth) || options.depth < 0)) throw new CliError("--depth must be 0 or more");
    if (!Number.isInteger(options.cycles) || options.cycles < 1 || options.cycles > 50) throw new CliError("--cycles must be from 1 to 50");
    return { positional, options };
}

/** Whether the command line asks for JSON, read without parsing it, for an error parsing throws */
function wantsJson(argv: string[]): boolean {
    const end = argv.indexOf("--");
    return (end < 0 ? argv : argv.slice(0, end)).includes("--json");
}

/** mist's version from its package.json: ../ of bin/mist.ts, ../../ of the built dist/bin/mist.js */
function version(): string {
    for (const path of ["../package.json", "../../package.json"]) {
        try {
            const pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
            if (pkg?.name === "@aurologic/mist-api" && typeof pkg.version === "string") return pkg.version;
        } catch { }
    }
    throw new CliError("mist can't find its package.json to read its version");
}

const printJson = (value: unknown) => console.log(JSON.stringify(value, null, 2));

/** `value` as `lines` say, or as JSON with --json */
function print<T>(value: T, lines: (value: T) => string[], options: Options) {
    if (options.json) return printJson(value);
    const out = lines(value);
    console.log(out.length ? out.join("\n") : "Nothing recorded yet.");
}

/**
 * Runs a watch until Ctrl+C; a second Ctrl+C exits at once, unless `holdExit` says why the run
 * has to end by itself, which then prints instead
 */
async function untilInterrupted<T>(run: (stopped: () => boolean) => Promise<T>, holdExit?: string): Promise<T> {
    let interrupted = false;
    const interrupt = () => {
        if (interrupted && holdExit) console.error(holdExit);
        else if (interrupted) process.exit(130);
        interrupted = true;
    };
    process.on("SIGINT", interrupt);
    try {
        return await run(() => interrupted);
    } finally {
        process.off("SIGINT", interrupt);
    }
}

/** A CLI argument as a call argument: JSON when it parses, the plain string otherwise */
const argument = (raw: string): unknown => {
    try { return JSON.parse(raw); } catch { return raw; }
};

const limitsOf = (options: Options) => options.full ? RECORDED : DISPLAY;

async function errors(conn: Connection, plugin: string | undefined, options: Options) {
    const show = (record: ErrorRecord) => console.log(options.json ? JSON.stringify(record) : errorLines(record, time).join("\n"));
    let backlog: ErrorRecord[] | null = [];
    await untilInterrupted(stopped => watchErrors(conn.send, conn.on, {
        follow: options.follow,
        stopped,
        limits: limitsOf(options),
        onReplayed: () => {
            // The page replays its console first, then exceptions and log entries
            const kept = backlog!.sort((a, b) => a.at - b.at);
            backlog = null;
            if (!kept.length && !options.json) console.error(`No errors${plugin ? ` from ${plugin}` : ""} in what the page kept${options.follow ? ". Watching until Ctrl+C" : ""}`);
            if (kept.length > options.count) console.error(`… ${kept.length - options.count} older errors (-n shows more)`);
            kept.slice(-options.count).forEach(show);
        },
    }, record => {
        if (plugin && !record.plugins.includes(plugin)) return;
        if (backlog) backlog.push(record);
        else show(record);
    }));
}

async function dev(conn: Connection, id: string, options: Options) {
    await untilInterrupted(stopped => watchDev(conn.send, id, {
        stopped,
        patches: async () => patchHealth(await readPatches(conn.send, id)),
        onStart: ({ source, state }) => {
            let now = "not running";
            if (state.error) now = `start error: ${state.error}`;
            else if (state.running) now = "running";
            const note = source === "dev" ? "" : `. ${id} is a ${source} install: Evi hot-reloads only dev builds (userplugins/)`;
            console.error(`Watching ${id} ${state.version} (${now}) for hot reloads until Ctrl+C${note}`);
        },
    }, outcome => console.log(options.json ? JSON.stringify(outcome) : devLines(outcome, time).join("\n"))));
}

function fluxLines({ records, dropped }: FluxBatch): string[] {
    return [
        ...dropped ? [`… ${dropped} actions dropped: the page keeps 1000 between reads`] : [],
        ...records.map(record => `${time(record.at)} ${record.type} ${JSON.stringify(record.payload)}`),
    ];
}

async function flux(conn: Connection, types: string[], options: Options) {
    console.error(`Watching ${types.length ? types.join(", ") : "every action"}${options.follow ? " until Ctrl+C" : `, up to ${options.count}`}`);
    await untilInterrupted(stopped => watchFlux(conn.send, { types, count: options.follow ? null : options.count, limits: limitsOf(options), ttlMs: WATCH_TTL_MS, stopped }, batch => {
        if (options.json) for (const record of batch.records) console.log(JSON.stringify(record));
        else for (const line of fluxLines(batch)) console.log(line);
        if (!batch.alive) console.error(watchEndedMessage(WATCH_TTL_MS));
    }));
}

function storeLines({ store, methods, stateKeys }: StoreMethods): string[] {
    const names = (readable: boolean) => methods.filter(method => method.readable === readable).map(method => method.name).join(" ") || "none";
    return [
        store,
        `  reads: ${names(true)}`,
        `  not called by mist: ${names(false)}`,
        ...stateKeys ? [`  getState(): ${stateKeys.join(" ") || "no keys"}`] : [],
    ];
}

type NativeLogs = { full: boolean; calls: CallRecord[]; logs: LogRecord[]; quiet?: Record<string, number>; };

const nativeLogLines = (answer: NativeLogs) => [
    "calls", ...answer.calls.map(callLine),
    ...quietCounts(answer.quiet) ? [`quiet calls, counted and not kept: ${quietCounts(answer.quiet)}`] : [],
    "logs", ...answer.logs.map(logLine),
];

/** A help row: the command with its arguments, and what it does */
type HelpRow = [usage: string, about: string];

interface CommandInfo {
    help: HelpRow[];
    /** For each positional argument the command can't run without, the error when it's missing; checked before mist connects */
    needs?: string[];
}

/** A command that runs without Discord, or one that runs on a connection to Discord's page */
type Command = CommandInfo & (
    | { offline: true; run(args: string[], options: Options): Promise<void> | void; }
    | { offline?: false; run(conn: Connection, args: string[], options: Options): Promise<void>; }
);

const needsPlugin = (command: string) => [`mist ${command} needs a plugin id (mist status lists them)`];

const COMMANDS: Record<string, Command> = {
    status: {
        help: [["status", "every mist plugin: running, errors, patch and lookup health"]],
        run: async (conn, _args, options) => print(await readStatus(conn.send), statusLines, options),
    },
    logs: {
        help: [["logs <id> [-f]", "the plugin's page log; -f keeps printing new lines"]],
        needs: needsPlugin("logs"),
        async run(conn, [id], options) {
            if (options.follow) return await followLogs(conn.send, id, options.count);
            print(await readLogs(conn.send, id, options.count), records => records.map(logLine), options);
        },
    },
    calls: {
        help: [["calls <id>", "its native calls: arguments, result or error, time taken"]],
        needs: needsPlugin("calls"),
        async run(conn, [id], options) {
            const calls = await callCapability<CallRecord[]>(conn.send, id, "function (n) { return this.calls(n); }", [options.count]);
            print(calls, records => records.map(callLine), options);
        },
    },
    "native-logs": {
        help: [["native-logs <id>", "what its native side logged and was called with"]],
        needs: needsPlugin("native-logs"),
        async run(conn, [id], options) {
            const answer = await callCapability<NativeLogs | null>(conn.send, id, "function (n) { return this.nativeLogs(n); }", [options.count]);
            if (!answer) throw new CliError(`${id} has no native side made with defineNative, or isn't running`);
            if (!answer.full) console.error("Values are shown as type and size only: Discord's main process has no --remote-debugging-port.");
            print(answer, nativeLogLines, options);
        },
    },
    values: {
        help: [["values <id>", "the values it exposes, and its settings"]],
        needs: needsPlugin("values"),
        run: async (conn, [id]) => printJson(await callCapability(conn.send, id, "function () { return { values: this.values(), settings: this.settings() }; }")),
    },
    call: {
        help: [["call <id> <method> [args]", "calls a native method; each arg is JSON, or a plain string"]],
        needs: [...needsPlugin("call"), "mist call needs a method name"],
        async run(conn, [id, method, ...rest]) {
            // The arguments may hold a secret: they go only to a handle the registry has no doubt about
            const doubts = await concerns(conn.send, id);
            if (doubts === null) console.error(`mist can't check ${id}'s handle: the page's registry keeps no history.`);
            else if (doubts.length) throw new CliError(`mist call sends nothing to ${id}:\n  ${doubts.join("\n  ")}\nmist status shows the registry's history. Restart Discord to start a fresh registry.`);
            printJson(await callCapability(conn.send, id, "function (method, args) { return this.call(method, ...args); }", [method, rest.map(argument)]));
        },
    },
    patches: {
        help: [["patches [id]", "Evi's patch and lookup diagnosis, problems first"]],
        run: async (conn, [id], options) => print(await readPatches(conn.send, id), patchLines, options),
    },
    eval: {
        help: [["eval <expression>", "evaluates in Discord's page and prints the result"]],
        needs: ["mist eval needs an expression"],
        run: async (conn, args) => printJson(await evaluate(conn.send, args.join(" "))),
    },
    flux: {
        help: [["flux [types...] [-f]", "prints Flux actions as Discord dispatches them, all types without any"]],
        run: (conn, args, options) => flux(conn, args, options),
    },
    store: {
        help: [["store <name> [method]", "lists a Flux store's methods, or calls a reading one with args"]],
        needs: ["mist store needs a store name, as in UserStore"],
        async run(conn, [store, method, ...rest], options) {
            if (!method) return print(await listStore(conn.send, store), storeLines, options);
            printJson((await callStore(conn.send, store, method, rest.map(argument), limitsOf(options))).result);
        },
    },
    inspect: {
        help: [["inspect <selector>", "an element's layout and its ancestors', with the CSS rules that set it"]],
        needs: ["mist inspect needs a CSS selector"],
        async run(conn, args, options) {
            const selector = args.join(" ");
            print(await inspect(conn.send, selector, options.depth ?? 4, options.all), inspected => inspectLines(inspected, selector), options);
        },
    },
    errors: {
        help: [["errors [id] [-f]", "console errors and uncaught exceptions, by plugin, source-mapped"]],
        run: (conn, [id], options) => errors(conn, id, options),
    },
    perf: {
        help: [["perf", "where plugins spend time, and applied patches whose $self calls never ran"]],
        run: async (conn, _args, options) => print(await readPerf(conn.send), report => perfLines(report, options.all ? Infinity : 5), options),
    },
    dev: {
        help: [["dev <id>", "each hot reload of a plugin: reloaded, start error, patch health"]],
        needs: needsPlugin("dev"),
        run: (conn, [id], options) => dev(conn, id, options),
    },
    module: {
        help: [["module <id|text> [--diff]", "a webpack module's patched source, or its diff against the original"]],
        needs: ["mist module needs a module id, or text from its source"],
        async run(conn, args, options) {
            print(await readModule(conn.send, conn.on, args.join(" ")), report => moduleLines(report, options.diff), options);
        },
    },
    react: {
        help: [["react <selector>", "the React components above an element, their props, and which are hooked"]],
        needs: ["mist react needs a CSS selector"],
        async run(conn, args, options) {
            const selector = args.join(" ");
            const limits = options.full ? RECORDED : { ...DISPLAY, depth: 2 };
            print(await readReact(conn.send, selector, options.depth ?? 10, limits), tree => reactLines(tree, selector), options);
        },
    },
    manifest: {
        help: [
            ["manifest fix [dir]", "missing translations, and a changelog over Evi's 16 KB; --write fixes"],
            [`manifest bump [dir] <version|patch|minor|major> --note "..."`, "the next version and its changelog entry; --write writes it"],
        ],
        needs: ["mist manifest needs a subcommand: fix or bump"],
        offline: true,
        run([sub, ...rest], options) {
            if (sub === "fix") return print(fixManifestDir(rest[0] ?? ".", options.write), fixLines, options);
            if (sub !== "bump") throw new CliError(`mist manifest has two subcommands, fix and bump, not ${sub}`);
            // mist manifest bump [dir] <version>: the version is always last
            const [dir, target] = rest.length > 1 ? rest : [".", rest[0]];
            if (!target) throw new CliError("mist manifest bump needs the new version, or patch, minor or major");
            print(bumpManifestDir(dir, target, options.notes, options.write), bumpLines, options);
        },
    },
    leaks: {
        help: [["leaks <id> --yes", "turns a dev plugin off and on, comparing what stays behind"]],
        needs: needsPlugin("leaks"),
        async run(conn, [id], options) {
            if (!options.yes) {
                await checkLeakTarget(conn.send, id);
                throw new CliError(`mist leaks turns ${id} off and on ${options.cycles} times and leaves it on. Add --yes to run it.`);
            }
            console.error(`Turning ${id} off and on ${options.cycles} times. Ctrl+C stops after turning it on again.`);
            const report = await untilInterrupted(stopped => findLeaks(conn.send, id, { cycles: options.cycles, stopped }), `Turning ${id} on again before mist leaks exits`);
            print(report, leakLines, options);
        },
    },
    restart: {
        help: [["restart [--wait <id>]", "restarts Discord with --remote-debugging-port; --wait waits for a plugin to run"]],
        offline: true,
        async run(_args, options) {
            await restart(options.port, options.dryRun);
            if (!options.wait || options.dryRun) return;
            const result = await waitForPlugin(options.port, options.wait, options.timeout * 1000);
            console.log(waitLine(options.wait, result));
            if (!result.running) process.exitCode = 1;
        },
    },
};

const OPTIONS_HELP: HelpRow[] = [
    ["--port <n>", "debugging port (default 9222)"],
    ["-n <count>", "how many records (default 50); flux: how many actions"],
    ["--json", `prints raw JSON; an error prints as {"error": "..."}`],
    ["--full", "flux, store, errors, react: values cut at mist's recorded-value bounds, not the shorter display ones"],
    ["--depth <n>", "inspect: how many ancestors (default 4); react: how many components (default 10)"],
    ["--all", "inspect: every match, not only the first; perf: every site, not the top 5"],
    ["--dry-run", "restart: prints what it would run"],
    ["--diff", "module: the patches' changes instead of the whole source"],
    ["--write", "manifest fix, bump: writes manifest.json"],
    ["--note <text>", "manifest bump: an English note for the new version; repeat for more"],
    ["--note-<lang> <text>", "manifest bump: that language's note (de, es, fr, ja, pl, pt-BR, ru, tr); without one, a copy of the English"],
    ["--wait <id>", "restart: waits until that plugin's page side runs"],
    ["--timeout <s>", "restart --wait: how long to wait (default 60)"],
    ["--cycles <n>", "leaks: how many off and on cycles (default 3)"],
    ["--yes", "leaks: turns the plugin off and on; without it, leaks only checks it may"],
    ["-v, --version", "prints mist's version"],
    ["-h, --help", "prints this help"],
    ["--", "ends the options: what follows is an argument even when it starts with -"],
];

/** Rows as two aligned columns; a label too wide for the first column takes a line to itself */
function columns(rows: HelpRow[]): string[] {
    const width = 26;
    return rows.flatMap(([label, about]) => label.length < width
        ? [`  ${label.padEnd(width)}  ${about}`]
        : [`  ${label}`, `  ${"".padEnd(width)}  ${about}`]);
}

const USAGE = [
    "mist <command> [options]",
    "",
    ...columns(Object.values(COMMANDS).flatMap(command => command.help)),
    "",
    ...columns(OPTIONS_HELP),
].join("\n");

/** The command's usage lines, for an error about its arguments */
const usageOf = (command: Command) => command.help.map(([usage]) => `mist ${usage}`).join("\n       ");

async function main(argv: string[]) {
    const { positional: [name, ...args], options } = parse(argv);
    if (options.version) return console.log(version());
    if (!name || name === "help" || options.help) return console.log(USAGE);
    if (!Object.hasOwn(COMMANDS, name)) throw new CliError(`Unknown command ${name}\n\n${USAGE}`);
    const command = COMMANDS[name];
    command.needs?.forEach((message, i) => {
        if (!args[i]) throw new CliError(`${message}\nUsage: ${usageOf(command)}`);
    });
    if (command.offline) return await command.run(args, options);
    const conn = await connect(options.port);
    try {
        await command.run(conn, args, options);
    } finally {
        conn.close();
    }
}

const argv = process.argv.slice(2);
main(argv).catch(err => {
    // --json keeps errors machine-readable on stdout, where the command's JSON would have gone
    if (wantsJson(argv)) console.log(JSON.stringify({ error: errorText(err) }));
    else console.error(err instanceof CliError ? err.message : err);
    process.exitCode = 1;
});
