/**
 * A debug report a plugin's user can copy into a bug report. It is built only from the page-wide
 * handle's views, where every value is reduced to its type and size, so it shows nothing that any
 * other plugin on the page can't already read.
 */
import { type CallRecord, errorMessage, type LogRecord, MIST_VERSION } from "./protocol.ts";
import { eviOf, type MistHandle, type Registry, status } from "./registry.ts";
import type { Reduced } from "./values.ts";

const RECENT = 50;

interface DiscordEnv { RELEASE_CHANNEL?: string; SENTRY_TAGS?: { buildId?: string; }; }

const time = (at: number) => new Date(at).toISOString().slice(11, 23);

function logLine(r: LogRecord<Reduced>) {
    return `  ${time(r.at)} ${r.level.padEnd(5)} ${r.args.join(" ")}`;
}

function callLine(r: CallRecord<Reduced>) {
    const head = `  ${time(r.at)} ${r.method}(${r.args.join(", ")})`;
    switch (r.outcome.state) {
        case "pending": return `${head} pending`;
        case "ok": return `${head} ok ${Math.round(r.outcome.ms)}ms -> ${r.outcome.result}`;
        case "error": return `${head} failed ${Math.round(r.outcome.ms)}ms: ${r.outcome.message}`;
    }
}

function section(title: string, lines: string[]) {
    return ["", `${title}:`, ...lines.length ? lines : ["  (none)"]];
}

async function read<T>(fn: () => T | Promise<T>): Promise<{ ok: true; value: T; } | { ok: false; error: string; }> {
    try {
        return { ok: true, value: await fn() };
    } catch (err) {
        return { ok: false, error: errorMessage(err) };
    }
}

export async function buildReport(handle: MistHandle, registry: Registry, root: object = globalThis): Promise<string> {
    const id = handle.id;
    const evi = eviOf(root);
    const env = (root as { GLOBAL_ENV?: DiscordEnv; }).GLOBAL_ENV;
    const plugin = await read(() => evi?.plugins?.get(id));
    const version = plugin.ok ? plugin.value?.manifest?.version : undefined;
    const discord = env?.RELEASE_CHANNEL ? `${env.RELEASE_CHANNEL}${env.SENTRY_TAGS?.buildId ? ` build ${env.SENTRY_TAGS.buildId}` : ""}` : "unknown";

    const lines = [
        `Debug report for ${id} ${version ?? "(version unknown)"}`,
        `mist-api ${handle.mistVersion}${handle.mistVersion === MIST_VERSION ? "" : ` (report made by ${MIST_VERSION})`}, Evi ${evi?.version ?? "unknown"}, Discord ${discord}`,
        `Made ${new Date().toISOString()}. Every value shows as its type and size only.`,
    ];

    const [s] = status([handle], evi, registry);
    if (s) {
        const state = s.state;
        if ("error" in state) lines.push("", `State unreadable: ${state.error}`);
        else lines.push("", `${state.running ? "Running" : "Stopped"}, native side: ${state.native}, errors kept: ${state.errors.calls} failed calls, ${state.errors.logs} error log lines`);
        if (s.startError) lines.push(`Start error: ${s.startError}`);
        if (!("error" in state)) for (const warning of state.warnings ?? []) lines.push(`Warning: ${warning}`);
        for (const concern of s.concerns ?? []) lines.push(`Registry concern: ${concern}`);
        if (s.patches && "error" in s.patches) lines.push(`Patches: ${s.patches.error}`);
        else if (s.patches) {
            lines.push(`Patches: ${counts(s.patches.health)}`);
            for (const p of s.patches.problems) lines.push(`  #${p.index} ${p.health} find ${p.find}${p.errors.length ? `: ${p.errors.join("; ")}` : ""}`);
        }
        if (s.lookups && "error" in s.lookups) lines.push(`Lookups: ${s.lookups.error}`);
        else if (s.lookups) {
            lines.push(`Lookups: ${counts(s.lookups.health)}`);
            for (const l of s.lookups.problems) lines.push(`  ${l.health} ${l.target}`);
        }
    }

    const logs = await read(() => handle.logs(RECENT));
    lines.push(...section(`Page log, last ${RECENT}`, logs.ok ? logs.value.map(logLine) : [`  unreadable: ${logs.error}`]));
    const calls = await read(() => handle.calls(RECENT));
    lines.push(...section(`Native calls, last ${RECENT}`, calls.ok ? calls.value.map(callLine) : [`  unreadable: ${calls.error}`]));
    const native = await read(() => handle.nativeLogs(RECENT));
    if (!native.ok) lines.push(...section("Native side", [`  unreadable: ${native.error}`]));
    else if (native.value) {
        lines.push(...section(`Native side's log, last ${RECENT}`, native.value.logs.map(logLine)));
        lines.push(...section(`Calls the native side received, last ${RECENT}`, native.value.calls.map(callLine)));
    }
    return lines.join("\n");
}

const counts = (health: Record<string, number>) => Object.entries(health).map(([k, v]) => `${v} ${k}`).join(", ") || "none";

/** Copies with the Clipboard API, or with a selected textarea where that is refused (the page isn't focused) */
export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch { }
    if (typeof document === "undefined") return false;
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    try {
        area.select();
        return document.execCommand("copy");
    } catch {
        return false;
    } finally {
        area.remove();
    }
}
