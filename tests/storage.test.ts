import { afterEach, beforeEach, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";

import { createMist } from "../src/index";
import { storageName } from "../src/storage";

const root = globalThis as { indexedDB?: unknown; };

beforeEach(() => void (root.indexedDB = new IDBFactory()));
afterEach(() => void delete root.indexedDB);

test("storage keeps JSON values by key, and keys and clear cover only this plugin", async () => {
    const notes = createMist("t-storage-notes").storage;
    const other = createMist("t-storage-other").storage;
    await notes.set("draft", { text: "hi", at: new Date(0) });
    await notes.set("count", 3);
    await other.set("draft", "theirs");

    expect(await notes.get("draft")).toEqual({ text: "hi", at: "1970-01-01T00:00:00.000Z" });
    expect(await notes.get("missing")).toBeUndefined();
    expect((await notes.keys()).sort()).toEqual(["count", "draft"]);

    await notes.del("count");
    expect(await notes.keys()).toEqual(["draft"]);
    await notes.clear();
    expect(await notes.keys()).toEqual([]);
    expect(await other.get("draft")).toBe("theirs");
});

test("a value read back is a copy, not the object that was stored", async () => {
    const storage = createMist("t-storage-copy").storage;
    const list = [1];
    await storage.set("list", list);
    list.push(2);
    const read = await storage.get("list") as number[];
    read.push(3);
    expect(await storage.get("list")).toEqual([1]);
});

test("concurrent updates of a key each see the one before", async () => {
    const storage = createMist("t-storage-update").storage;
    const results = await Promise.all(Array.from({ length: 20 }, () => storage.update("n", n => (typeof n === "number" ? n : 0) + 1)));
    expect(await storage.get("n")).toBe(20);
    expect([...results].sort((a, b) => (a as number) - (b as number))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
});

test("update that returns undefined deletes the key, and one that throws changes nothing and rejects", async () => {
    const storage = createMist("t-storage-update-edge").storage;
    await storage.set("a", 1);
    expect(await storage.update("a", () => undefined)).toBeUndefined();
    expect(await storage.keys()).toEqual([]);

    await storage.set("b", 1);
    await expect(storage.update("b", () => { throw new Error("no thanks"); })).rejects.toThrow("no thanks");
    expect(await storage.get("b")).toBe(1);
});

test("update with an async function rejects, saying it must be synchronous, and stores nothing", async () => {
    const store = createMist("t-storage-async").storage;
    await store.set("count", 1);
    const err = await store.update("count", async value => (value as number) + 1).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toStartWith("update's function must be synchronous");
    expect(await store.get("count")).toBe(1);
    // A rejecting async function doesn't leave an unhandled rejection behind
    await expect(store.update("count", async () => { throw new Error("late"); })).rejects.toThrow("must be synchronous");
});

test("a value JSON can't write rejects and stores nothing", async () => {
    const storage = createMist("t-storage-json").storage;
    await expect(storage.set("big", 1n)).rejects.toThrow(/BigInt/);
    await expect(storage.set("fn", () => 1)).rejects.toThrow(/Can't store function as JSON/);
    await expect(storage.update("big", () => 1n)).rejects.toThrow(/BigInt/);
    expect(await storage.keys()).toEqual([]);
});

test("each account has its own store, apart from the plugin-wide one", async () => {
    const storage = createMist("t-storage-accounts").storage;
    await storage.set("theme", "dark");
    await storage.account("111").set("draft", "one");
    await storage.account("222").set("draft", "two");

    expect(await storage.account("111").get("draft")).toBe("one");
    expect(await storage.account("222").get("draft")).toBe("two");
    expect(await storage.keys()).toEqual(["theme"]);
    await storage.account("111").clear();
    expect(await storage.account("222").keys()).toEqual(["draft"]);
    expect(() => storage.account("")).toThrow(/no account is signed in/);
});

test("the database is mist's own, so it never opens the evi-<id> one the plugin guide suggests", async () => {
    await createMist("t-storage-name").storage.set("k", 1);
    const names = (await (root.indexedDB as IDBFactory).databases()).map(db => db.name);
    expect(names).toEqual([storageName("t-storage-name")]);
    expect(names[0]).not.toBe("evi-t-storage-name");
});

test("without IndexedDB each call rejects with an error that says so", async () => {
    delete root.indexedDB;
    const storage = createMist("t-storage-none").storage;
    await expect(storage.get("k")).rejects.toThrow("IndexedDB isn't available on this page, so mist-api:t-storage-none can't be opened");
    await expect(storage.set("k", 1)).rejects.toThrow(/IndexedDB isn't available/);
});

test("an IndexedDB that throws on open rejects with its error, and the next call tries again", async () => {
    const real = root.indexedDB as IDBFactory;
    root.indexedDB = { open() { throw new DOMException("The user denied permission", "SecurityError"); } };
    const storage = createMist("t-storage-denied").storage;
    await expect(storage.get("k")).rejects.toThrow("The user denied permission");
    root.indexedDB = real;
    await storage.set("k", 1);
    expect(await storage.get("k")).toBe(1);
});

test("a database deleted from elsewhere isn't blocked by mist's open connection, and mist opens it again", async () => {
    const storage = createMist("t-storage-delete").storage;
    await storage.set("k", 1);
    await new Promise<void>((resolve, reject) => {
        const request = (root.indexedDB as IDBFactory).deleteDatabase(storageName("t-storage-delete"));
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("blocked"));
    });
    expect(await storage.get("k")).toBeUndefined();
    await storage.set("k", 2);
    expect(await storage.get("k")).toBe(2);
});

test("a stored value that isn't JSON rejects get with the parse error", async () => {
    const storage = createMist("t-storage-corrupt").storage;
    await storage.set("k", 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = (root.indexedDB as IDBFactory).open(storageName("t-storage-corrupt"), 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    await new Promise<void>(resolve => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put("{not json", "k");
        tx.oncomplete = () => resolve();
    });
    db.close();
    await expect(storage.get("k")).rejects.toBeInstanceOf(SyntaxError);
});
