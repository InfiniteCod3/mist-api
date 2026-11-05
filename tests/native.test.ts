import type { NativeContext } from "@evi/api/native";
import { expect, test } from "bun:test";
import { join } from "node:path";

import { debugAllowed, defineNative, log } from "../src/native";
import { copyOfSources } from "./copies";

test("debugAllowed reads main's flags", () => {
    expect(debugAllowed(["discord.exe", "--remote-debugging-port=9222"])).toBe(true);
    expect(debugAllowed(["discord.exe", "--remote-debugging-pipe"])).toBe(true);
    expect(debugAllowed(["discord.exe", "--remote-debugging-portal=1", "--inspect"])).toBe(false);
});

// bun test runs without --remote-debugging-port, like a normal Discord
let started = "";
const module = defineNative({
    add(a: number, b: number) { return a + b; },
    async forecast(_city: string, keys: { apiKey: string; }) { return keys.apiKey ? "sunny" : null; },
    fail(): number { throw new Error("broken"); },
    start(ctx) { started = ctx.pluginId; },
});

test("wraps methods, runs start with its context, and adds the hidden methods", async () => {
    module.start({ pluginId: "t-native" } as NativeContext);
    expect(started).toBe("t-native");
    expect(module.add(1, 2)).toBe(3);
    expect(await module.forecast("Oslo", { apiKey: "k-123" })).toBe("sunny");
    expect(() => module.fail()).toThrow("broken");
    expect(module.__mist_debugAllowed()).toBe(false);
});

test("records calls, reduced to type and size without a debugging port, even when the page asks for full", async () => {
    log.warn("native says token k-456", { secretish: "abc" });
    log.log("native plain line");
    const answer = module.__mist_logs(10, true);
    expect(answer.full).toBe(false);
    expect(answer.calls.map(c => [c.method, c.outcome.state])).toEqual([["add", "ok"], ["forecast", "ok"], ["fail", "error"]]);
    expect(answer.calls[1].args).toEqual(["string(4)", "object(1 keys)"]);
    expect(answer.calls[2].outcome).toMatchObject({ state: "error", message: "string(6)" });
    expect(answer.logs.at(-2)).toMatchObject({ level: "warn", args: ["string(23)", "object(1 keys)"] });
    expect(answer.logs.at(-1)).toMatchObject({ level: "log", args: ["string(17)"] });
    expect(JSON.stringify(answer)).not.toMatch(/k-123|k-456|broken/);
});

test("reserves the __mist_ prefix, and runs once per bundle", () => {
    expect(() => defineNative({ __mist_x() { } })).toThrow(/reserved/);
    expect(() => defineNative({})).toThrow(/already ran/);
});

/** A fresh copy's defineNative, with main started with a debugging port so records come whole */
async function withFreshNative(run: (fresh: typeof import("../src/native")) => void | Promise<void>) {
    const copy = copyOfSources("0.0.1-fresh");
    const argv = process.argv;
    process.argv = [...argv, "--remote-debugging-port=9222"];
    try {
        await run(await import(join(copy.dir, "native.ts")));
    } finally {
        process.argv = argv;
        copy.remove();
    }
}

test("log lines written before defineNative are kept with defineNative's options", () => withFreshNative(fresh => {
    fresh.log.info("dropped");
    fresh.log.info("loading", { licenseKey: "k-early" });
    const made = fresh.defineNative({}, { secrets: ["licenseKey"], capacity: 2 });
    fresh.log.info("defined");
    const answer = made.__mist_logs(10, true);
    expect(answer.full).toBe(true);
    expect<unknown>(answer.logs.map(l => l.args)).toEqual([["loading", { licenseKey: "[secret]" }], ["defined"]]);
}));

test("defineNative's secretArgs masks a bare secret argument of the named method, and only names the module's methods", () => withFreshNative(fresh => {
    const made = fresh.defineNative({
        login(_user: string, code: string) { return code.length; },
    }, { secretArgs: { login: [1] } });
    made.login("ada", "one-time-code");
    const answer = made.__mist_logs(10, true);
    expect<unknown>(answer.calls.map(c => c.args)).toEqual([["ada", "[secret]"]]);
    // @ts-expect-error secretArgs names the module's own methods
    void (() => fresh.defineNative({ login() { } }, { secretArgs: { logn: [1] } }));
}));

test("defineNative's quiet methods are counted in the answer to the page and not kept", () => withFreshNative(async fresh => {
    const made = fresh.defineNative({
        async poll(cursor: number) { return cursor + 1; },
        send(text: string) { return text.length; },
    }, { quiet: ["poll"] });
    await made.poll(0);
    await made.poll(1);
    made.send("hi");
    const answer = made.__mist_logs(10, true);
    expect(answer.calls.map(c => c.method)).toEqual(["send"]);
    expect(answer.quiet).toEqual({ poll: 2 });
    // @ts-expect-error quiet names the module's own methods
    void (() => fresh.defineNative({ poll() { } }, { quiet: ["pol"] }));
}));

test("start and stop get the run's this.signal, which aborts once stop returns, and a new start gets a new one", () => withFreshNative(fresh => {
    const seen: { where: string; signal: AbortSignal; aborted: boolean; }[] = [];
    const made = fresh.defineNative({
        start() { seen.push({ where: "start", signal: this.signal, aborted: this.signal.aborted }); },
        stop() { seen.push({ where: "stop", signal: this.signal, aborted: this.signal.aborted }); },
        ping() { return this.signal; },
    });
    const ctx = { pluginId: "t-run-signal" } as NativeContext;
    made.start(ctx);
    const during = made.ping() as AbortSignal;
    made.stop();
    made.start(ctx);
    expect(seen.map(s => [s.where, s.signal instanceof AbortSignal, s.aborted])).toEqual([["start", true, false], ["stop", true, false], ["start", true, false]]);
    expect(seen[1].signal).toBe(seen[0].signal);
    expect(seen[0].signal.aborted).toBe(true);
    expect(during.aborted).toBe(true);
    expect(seen[2].signal).not.toBe(seen[0].signal);
}));
