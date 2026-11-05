import type { NativeContext } from "@evi/api/native";
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";

import { createMist } from "../src/index";
import { copyOfSources } from "./copies";
import { electronBridge, fakeContext, mistNative } from "./helpers";

const removes: (() => void)[] = [];
afterAll(() => { for (const remove of removes) remove(); });

interface Asks {
    confirm(text: string): boolean;
    pickColor(options: { allowAlpha: boolean; }): string;
}

/** A native side whose `ask` method asks the page, in its own copy as each native bundle has */
async function asking(timeoutMs = 2000) {
    const copy = copyOfSources("0.0.1-requests");
    removes.push(copy.remove);
    const native = await import(join(copy.dir, "native.ts")) as typeof import("../src/native");
    const requests = native.nativeRequests<Asks>({ timeoutMs });
    const module = native.defineNative({
        ask(text: string) { return requests.request("confirm", text); },
        color() { return requests.request("pickColor", { allowAlpha: false }); },
    }, { requests });
    module.start({ pluginId: "t-requests" } as NativeContext);
    return { native, requests, module };
}

function page<N>(id: string, module: object) {
    const mist = createMist<{}, N>(id);
    const run = fakeContext(electronBridge(module), {}, id);
    mist.define({}).start!(run.ctx);
    return { mist, run };
}

async function rejection(pending: Promise<unknown>) {
    try {
        await pending;
    } catch (err) {
        return err;
    }
    throw new Error("expected a rejection");
}

test("the native side asks, the page's handler answers, and the answer reaches the waiting native code", async () => {
    const { module, requests } = await asking();
    const { mist, run } = page<typeof module>("t-ask", module);
    const asked: string[] = [];
    mist.requests.handle("confirm", text => {
        asked.push(text);
        return text === "Delete?";
    });
    mist.requests.handle("pickColor", async ({ allowAlpha }) => allowAlpha ? "#ff000080" : "#ff0000");
    // @ts-expect-error the page's handler answers what the native side's map says
    void (() => mist.requests.handle("confirm", () => "yes"));
    // @ts-expect-error only names the native side asks for
    void (() => mist.requests.handle("confrim", () => true));

    expect(await module.ask("Delete?")).toBe(true);
    expect(await requests.request("pickColor", { allowAlpha: true })).toBe("#ff000080");
    expect(asked).toEqual(["Delete?"]);
    run.dispose();
});

test("a request made before the page connects is delivered once the page handles it, and only once", async () => {
    const { module } = await asking();
    const early = module.ask("early?");
    const { mist, run } = page<typeof module>("t-early", module);
    let count = 0;
    mist.requests.handle("confirm", () => { count++; return true; });
    expect(await early).toBe(true);
    expect(await module.ask("second?")).toBe(true);
    expect(count).toBe(2);
    run.dispose();
});

test("a request fails with a code when nobody answers in time, when the page has no handler, or when the handler throws", async () => {
    const { module, requests } = await asking(30);
    const timedOut = await rejection(module.ask("anyone?"));
    expect(timedOut).toMatchObject({ code: "request-timeout" });

    const { mist, run } = page<typeof module>("t-fail", module);
    mist.requests.handle("pickColor", () => { throw new Error("no colors today"); });
    expect(await rejection(requests.request("confirm", "x", { timeoutMs: 2000 }))).toMatchObject({ code: "request-unhandled" });
    expect(await rejection(requests.request("pickColor", { allowAlpha: true }, { timeoutMs: 2000 }))).toMatchObject({ code: "request-failed", message: "no colors today" });
    run.dispose();
});

test("stopping the native side rejects every waiting request, and a stopped side refuses new ones", async () => {
    const { module, requests } = await asking();
    const waiting = [module.ask("a"), module.ask("b")];
    module.stop();
    for (const pending of waiting) expect(await rejection(pending)).toMatchObject({ code: "request-stopped" });
    expect(await rejection(requests.request("confirm", "c"))).toMatchObject({ code: "request-stopped" });
});

test("an aborted request rejects with the signal's reason and is no longer delivered", async () => {
    const { module, requests } = await asking();
    const controller = new AbortController();
    const pending = requests.request("confirm", "cancel me", { signal: controller.signal });
    controller.abort();
    expect(await rejection(pending)).toMatchObject({ name: "AbortError" });
    const answer = await module.__mist_requests(null, 0);
    expect(answer.events).toEqual([]);
});

test("a reply for an unknown request, or in a bad shape, is refused", async () => {
    const { module } = await asking();
    const pending = module.ask("shape?");
    const { events: [request] } = await module.__mist_requests(null, 0);
    expect(module.__mist_reply("not-an-id", { ok: true, value: true })).toBe(false);
    expect(module.__mist_reply(request.id, "yes")).toBe(false);
    expect(module.__mist_reply(request.id, { ok: true, value: false })).toBe(true);
    expect(module.__mist_reply(request.id, { ok: true, value: true })).toBe(false);
    expect(await pending).toBe(false);
});

test("a native side without requests support gets no polling from the page, which says why once", async () => {
    const mist = createMist<{}, {}>("t-no-requests");
    const calls: string[] = [];
    const native = mistNative(false);
    const run = fakeContext((method, ...args) => { calls.push(method); return native(method, ...args); }, {}, "t-no-requests");
    mist.define({}).start!(run.ctx);
    // @ts-expect-error a native module without requests takes no handlers
    mist.requests.handle("anything", () => 1);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).not.toContain("__mist_requests");
    expect(run.printed.filter(p => p.level === "warn").map(p => String(p.args[0]))).toEqual([expect.stringContaining("needs defineNative from @aurologic/mist-api 0.3")]);
    run.dispose();
});
