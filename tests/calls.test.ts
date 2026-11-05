import type { NativeContext } from "@evi/api/native";
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";

import { createMist, MistNativeError } from "../src/index";
import { HttpError } from "../src/util";
import { copyOfRelease, copyOfSources } from "./copies";
import { electronBridge, fakeContext, plainNative } from "./helpers";

const removes: (() => void)[] = [];
afterAll(() => { for (const remove of removes) remove(); });

/** This version's native side in its own copy, as each plugin's native bundle carries one */
async function freshNative() {
    const copy = copyOfSources("0.0.1-calls");
    removes.push(copy.remove);
    return {
        native: await import(join(copy.dir, "native.ts")) as typeof import("../src/native"),
        util: await import(join(copy.dir, "util.ts")) as typeof import("../src/util"),
    };
}

/** A running page of this version over Evi's IPC to `module` */
function page<N>(id: string, module: object) {
    const sent: { method: string; args: unknown[]; }[] = [];
    const mist = createMist<{}, N>(id);
    const run = fakeContext(electronBridge(module, sent), {}, id);
    mist.define({}).start!(run.ctx);
    return { mist, run, sent };
}

async function rejection(pending: Promise<unknown>) {
    try {
        await pending;
    } catch (err) {
        return err;
    }
    throw new Error("expected a rejection");
}

test("a NativeError reaches the page as a MistNativeError with its code and data, and an HttpError keeps its status", async () => {
    const { native, util } = await freshNative();
    const module = native.defineNative({
        save(name: string): string {
            if (!name) throw new native.NativeError("empty-name", { field: "name" }, "A name is needed");
            return `saved ${name}`;
        },
        async fetchIt(): Promise<void> { throw new util.HttpError(404); },
        broken(): void { throw new TypeError("not a function"); },
    });
    module.start({ pluginId: "t-errors" } as NativeContext);
    const { mist } = page<typeof module>("t-errors", module);

    expect(await mist.native.save("a")).toBe("saved a");
    const coded = await rejection(mist.native.save(""));
    expect(coded).toBeInstanceOf(MistNativeError);
    expect(coded).toMatchObject({ code: "empty-name", data: { field: "name" }, message: "A name is needed" });

    const http = await rejection(mist.native.fetchIt());
    expect(http).toBeInstanceOf(HttpError);
    expect((http as HttpError).status).toBe(404);

    const plain = await rejection(mist.native.broken());
    expect(plain).not.toBeInstanceOf(MistNativeError);
    expect(plain).toMatchObject({ name: "TypeError", message: "not a function" });
});

test("NativeError data that IPC can't clone is dropped, and the error still arrives", async () => {
    const { native } = await freshNative();
    const module = native.defineNative({
        odd(): void { throw new native.NativeError("odd", { callback: () => 1 }); },
    });
    module.start({ pluginId: "t-clone" } as NativeContext);
    const { mist } = page<typeof module>("t-clone", module);
    const err = await rejection(mist.native.odd());
    expect(err).toMatchObject({ code: "odd", data: undefined });
});

test("a page from mist 0.2.1 calls this native side as before: no mark, plain values, Electron's flattened errors", async () => {
    const old = copyOfRelease("v0.2.1");
    removes.push(old.remove);
    const { createMist: oldCreateMist } = await import(join(old.dir, "index.ts")) as typeof import("../src/index");
    const { native } = await freshNative();
    let seenArgs: unknown[] = [];
    const module = native.defineNative({
        add(...args: number[]) { seenArgs = args; return args.reduce((a, b) => a + b, 0); },
        fail(): void { throw new native.NativeError("nope"); },
    });
    module.start({ pluginId: "t-old-page" } as NativeContext);
    const mist = oldCreateMist<{}, typeof module>("t-old-page");
    mist.define({}).start!(fakeContext(electronBridge(module), {}, "t-old-page").ctx);

    expect(await mist.native.add(1, 2)).toBe(3);
    expect(seenArgs).toEqual([1, 2]);
    const err = await rejection(mist.native.fail());
    expect((err as Error).message).toBe("Error invoking remote method 'evi:plugin-native-call': NativeError: nope");
});

test("this page calls a mist 0.2.1 native side and a plain one as before: no mark, so a rest parameter sees only the arguments", async () => {
    const old = copyOfRelease("v0.2.1");
    removes.push(old.remove);
    const { defineNative: oldDefineNative } = await import(join(old.dir, "native.ts")) as typeof import("../src/native");
    let oldArgs: unknown[] = [];
    const oldModule = oldDefineNative({ add(...args: number[]) { oldArgs = args; return args.length; } });
    oldModule.start({ pluginId: "t-old-native" } as NativeContext);
    const fromOld = page<typeof oldModule>("t-old-native", oldModule);
    expect(await fromOld.mist.native.add(1, 2)).toBe(2);
    expect(oldArgs).toEqual([1, 2]);
    const aborted = new AbortController();
    const pending = fromOld.mist.native.add.with({ signal: aborted.signal })(5);
    aborted.abort();
    expect(await rejection(pending)).toMatchObject({ name: "AbortError" });
    expect(fromOld.sent.map(s => s.method)).not.toContain("__mist_abort");

    let plainArgs: unknown[] = [];
    const mist = createMist<{}, { add(...args: number[]): number; }>("t-plain");
    mist.define({}).start!(fakeContext(plainNative({ add: (...args: number[]) => { plainArgs = args; return args.length; } }), {}, "t-plain").ctx);
    expect(await mist.native.add(4, 5, 6)).toBe(3);
    expect(plainArgs).toEqual([4, 5, 6]);
});

test("aborting a call rejects it on the page at once and aborts the method's this.signal on the native side", async () => {
    const { native } = await freshNative();
    let seen: AbortSignal | undefined;
    let inner: AbortSignal | undefined;
    const module = native.defineNative({
        async slow(): Promise<string> {
            seen = this.signal;
            this.check();
            await new Promise(resolve => this.signal.addEventListener("abort", resolve));
            return "late";
        },
        check(): void { inner = this.signal; },
    });
    module.start({ pluginId: "t-abort" } as NativeContext);
    const { mist, sent } = page<typeof module>("t-abort", module);

    const controller = new AbortController();
    const pending = mist.native.slow.with({ signal: controller.signal })();
    while (!seen) await new Promise(resolve => setTimeout(resolve, 1));
    expect(seen.aborted).toBe(false);
    expect(inner).toBe(seen);
    controller.abort();
    expect(await rejection(pending)).toMatchObject({ name: "AbortError" });
    while (!seen.aborted) await new Promise(resolve => setTimeout(resolve, 1));
    expect(sent.map(s => s.method)).toContain("__mist_abort");

    const before = sent.length;
    const already = new AbortController();
    already.abort();
    expect(await rejection(mist.native.slow.with({ signal: already.signal })())).toMatchObject({ name: "AbortError" });
    expect(sent.length).toBe(before);
});

test("stopping the native side aborts the signal of every call in flight, with or without a page signal", async () => {
    const { native } = await freshNative();
    const signals: AbortSignal[] = [];
    const module = native.defineNative({
        wait(): Promise<void> {
            signals.push(this.signal);
            return new Promise(resolve => this.signal.addEventListener("abort", () => resolve()));
        },
    });
    module.start({ pluginId: "t-stop-abort" } as NativeContext);
    const { mist } = page<typeof module>("t-stop-abort", module);
    const calls = [mist.native.wait(), mist.native.wait.with({ signal: new AbortController().signal })()];
    while (signals.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
    module.stop();
    await Promise.all(calls);
    expect(signals.map(s => s.aborted)).toEqual([true, true]);

    module.start({ pluginId: "t-stop-abort" } as NativeContext);
    void mist.native.wait();
    while (signals.length < 3) await new Promise(resolve => setTimeout(resolve, 1));
    expect(signals[2].aborted).toBe(false);
    module.stop();
});

test("a call mark is stripped before the method and its record see the arguments", async () => {
    const copy = copyOfSources("0.0.1-mark");
    removes.push(copy.remove);
    const argv = process.argv;
    process.argv = [...argv, "--remote-debugging-port=9222"];
    try {
        const native = await import(join(copy.dir, "native.ts")) as typeof import("../src/native");
        let seen: unknown[] = [];
        const module = native.defineNative({ echo(...args: unknown[]) { seen = args; return args.length; } });
        module.start({ pluginId: "t-mark" } as NativeContext);
        const { mist } = page<typeof module>("t-mark", module);
        expect(await mist.native.echo("a", { b: 1 })).toBe(2);
        expect(seen).toEqual(["a", { b: 1 }]);
        const logs = module.__mist_logs(10, true);
        expect<unknown>(logs.calls.find(c => c.method === "echo")?.args).toEqual(["a", { b: 1 }]);
    } finally {
        process.argv = argv;
    }
});
