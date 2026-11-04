// Run by cdp.test.ts under Node, whose node:inspector speaks the same CDP as Discord's page
import { Session } from "node:inspector/promises";
import { pathToFileURL } from "node:url";

import { callOn, capability, concerns, type Send } from "../../bin/cdp.ts";

const { createMist } = await import(pathToFileURL(process.argv[2]).href);

const native = async (method: string, ...args: unknown[]) => {
    if (method === "__mist_debugAllowed") return true;
    if (method === "echo") return args[0];
    throw new Error(`no native method ${method}`);
};
const ctx = { id: "t-cdp", native: { call: native }, logger: { debug() { }, info() { }, warn() { }, error() { } }, settings: { all: {} }, onDispose() { } };

// A plugin that loads first keeps objects made before mist-api's, to forge from once the handle exists
const early = Array.from({ length: 20 }, () => ({}));

const mist = createMist("t-cdp");
await mist.define({}).start(ctx);
mist.log.info("token abc-123");

const handle = (globalThis as any).Mist.get("t-cdp");
const decoy = { open: () => true, call: async () => "decoy", logs: () => [{ at: 0, level: "info", args: ["decoy"] }] };
const protos = [handle.debugPrototype, Object.getPrototypeOf(handle)].filter(p => p && p !== Object.prototype);
for (const [i, object] of early.entries()) {
    Object.setPrototypeOf(object, protos[i % protos.length]);
    Object.assign(object, decoy);
}

const session = new Session();
session.connect();
const send: Send = (method, params) => session.post(method as any, params as any);
const id = await capability(send, "t-cdp", "test");
const clean = await concerns(send, "t-cdp");

// Page code tries to swap in its own handle while the plugin runs
const registry = (globalThis as any)[Symbol.for("mist-api.registry.v1")];
registry.register({ ...handle, state: () => ({ ...handle.state(), running: true }) });
createMist("t-cdp-stopped").define({});

console.log(JSON.stringify({
    call: await callOn(send, id, "function () { return this.call('echo', 'hi'); }"),
    logs: await callOn(send, id, "function () { return this.logs(); }"),
    handleLogs: handle.logs(),
    concerns: { clean, swapped: await concerns(send, "t-cdp"), stopped: await concerns(send, "t-cdp-stopped") },
}));
