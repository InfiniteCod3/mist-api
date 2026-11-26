import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";

import { channel, slot } from "../src/bus";
import { copyOfSources } from "./copies";

const copy = copyOfSources("0.0.2");
const other: typeof import("../src/bus") = await import(join(copy.dir, "bus.ts"));
afterAll(copy.remove);

test("a channel delivers across two copies of mist-api", () => {
    const got: string[] = [];
    const off = other.channel<string>("t-events", 1).subscribe(v => got.push(`other:${v}`));
    channel<string>("t-events", 1).subscribe(v => got.push(`here:${v}`));
    channel<string>("t-events", 1).publish("a");
    off();
    other.channel<string>("t-events", 1).publish("b");
    expect(got).toEqual(["other:a", "here:a", "here:b"]);
});

test("another version of a channel is another channel", () => {
    const got: unknown[] = [];
    channel("t-versioned", 1).subscribe(v => got.push(v));
    other.channel("t-versioned", 2).publish({ shape: "new" });
    expect(got).toEqual([]);
});

test("one listener throwing doesn't stop the others or the sender", () => {
    const got: number[] = [];
    channel<number>("t-throw", 1).subscribe(() => { throw new Error("bad listener"); });
    channel<number>("t-throw", 1).subscribe(v => got.push(v));
    expect(() => channel<number>("t-throw", 1).publish(7)).not.toThrow();
    expect(got).toEqual([7]);
});

test("a slot is shared across copies, and a stale release doesn't clear a newer value", () => {
    const seen: unknown[] = [];
    other.slot<{ name: string; }>("t-api", 1).subscribe(v => seen.push(v?.name));
    const releaseOld = slot<{ name: string; }>("t-api", 1).set({ name: "first" });
    expect(other.slot<{ name: string; }>("t-api", 1).get()?.name).toBe("first");
    const releaseNew = other.slot<{ name: string; }>("t-api", 1).set({ name: "second" });
    releaseOld();
    expect(slot<{ name: string; }>("t-api", 1).get()?.name).toBe("second");
    releaseNew();
    expect(slot("t-api", 1).get()).toBeUndefined();
    expect(seen).toEqual(["first", "second", undefined]);
});

test("a listener that throws is logged by name and channel, without the value, and the others still get it", () => {
    const printed: unknown[][] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void printed.push(args);
    try {
        const got: string[] = [];
        const feed = channel<{ secret: string; }>("t-throwing", 1);
        feed.subscribe(function brokenListener() { throw new Error("listener bug"); });
        feed.subscribe(value => got.push(value.secret));
        feed.publish({ secret: "hunter2" });
        expect(got).toEqual(["hunter2"]);
        expect(printed).toHaveLength(1);
        expect(printed[0][0]).toBe("channel t-throwing@1: a listener (brokenListener) threw");
        expect(JSON.stringify(printed[0].map(String))).not.toContain("hunter2");
    } finally {
        console.error = error;
    }
});

test("refuses names and versions that can't key a channel", () => {
    expect(() => channel("", 1)).toThrow();
    expect(() => channel("x", 0)).toThrow();
});

test("a bad name of any type is shown in a clean TypeError, a BigInt included, which JSON.stringify can't show", () => {
    expect(() => channel(10n as never, 1)).toThrow(new TypeError("channel: name must be a non-empty string, got 10n"));
    expect(() => slot(Symbol("x") as never, 1)).toThrow(new TypeError("slot: name must be a non-empty string, got Symbol(x)"));
    expect(() => channel({} as never, 1)).toThrow(new TypeError("channel: name must be a non-empty string, got an object"));
});
