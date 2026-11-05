import { expect, test } from "bun:test";

import { createMist } from "../src/index";
import { sleep } from "../src/util";
import { fakeContext } from "../src/testing";
import { mistNative } from "./helpers";

test("mist.signal aborts when the run is disposed, and each start gets a fresh one", () => {
    const mist = createMist("t-signal");
    const definition = mist.define({});
    expect(mist.signal.aborted).toBe(true);
    expect(mist.signal.reason).toMatchObject({ name: "AbortError", message: "t-signal stopped" });

    const first = fakeContext({ native: mistNative(false) });
    definition.start!(first.ctx);
    const signal = mist.signal;
    expect(signal.aborted).toBe(false);
    expect(mist.signal).toBe(signal);

    definition.stop?.(first.ctx);
    expect(signal.aborted).toBe(false);
    let runningOnAbort: boolean | undefined;
    signal.addEventListener("abort", () => void (runningOnAbort = mist.running));
    first.dispose();
    expect(runningOnAbort).toBe(false);
    expect(signal.aborted).toBe(true);
    expect(mist.signal.aborted).toBe(true);

    const second = fakeContext({ native: mistNative(false) });
    definition.start!(second.ctx);
    expect(mist.signal.aborted).toBe(false);
    expect(mist.signal).not.toBe(signal);
});

test("a new start aborts the old run's signal, and the old run's late dispose leaves the new one alone", () => {
    const mist = createMist("t-signal-rerun");
    const definition = mist.define({});
    const first = fakeContext({ native: mistNative(false) });
    const second = fakeContext({ native: mistNative(false) });
    definition.start!(first.ctx);
    const old = mist.signal;
    definition.start!(second.ctx);
    expect(old.aborted).toBe(true);
    first.dispose();
    expect(mist.signal.aborted).toBe(false);
});

test("sleep on mist.signal rejects with an AbortError when the plugin stops", async () => {
    const mist = createMist("t-signal-sleep");
    const definition = mist.define({});
    const run = fakeContext({ native: mistNative(false) });
    definition.start!(run.ctx);
    const waiting = sleep(60_000, mist.signal);
    run.dispose();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await expect(sleep(1, mist.signal)).rejects.toMatchObject({ name: "AbortError" });
});

test("mist.toast shows the toast while running and does nothing between runs", () => {
    const mist = createMist("t-toast");
    const definition = mist.define({});
    expect(() => mist.toast("before")).not.toThrow();

    const run = fakeContext({ native: mistNative(false) });
    definition.start!(run.ctx);
    mist.toast("during", { type: "success" });
    run.dispose();
    mist.toast("after");
    expect(run.toasts).toEqual(["during"]);
});
