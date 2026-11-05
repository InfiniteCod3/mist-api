/** A plugin's key-value store in the page's IndexedDB, one database per plugin id and per account. */

/** Keys map to JSON values. Values are stored as JSON text, so JSON.stringify's rules apply on the way in. */
export interface KeyValueStore {
    /** The stored value, parsed: validate it before use. undefined when the key isn't set. */
    get(key: string): Promise<unknown>;
    /** Rejects with JSON.stringify's error for a value it can't write, such as a BigInt or a cycle */
    set(key: string, value: unknown): Promise<void>;
    /**
     * Reads the value, calls `fn` with it and stores what it returns, in one transaction, so two
     * updates of a key never lose each other's write. `fn` must be synchronous. Returning undefined
     * deletes the key; throwing leaves the store as it was and rejects with that error.
     */
    update(key: string, fn: (value: unknown) => unknown): Promise<unknown>;
    del(key: string): Promise<void>;
    keys(): Promise<string[]>;
    clear(): Promise<void>;
}

export interface PluginStorage extends KeyValueStore {
    /**
     * The store of one Discord account, apart from the plugin's other stores. Discord switches
     * accounts without reloading the page, so bind it to the account a piece of data belongs to,
     * as in `account(currentUserId())`, and bind again after a switch.
     */
    account(userId: string): KeyValueStore;
}

const STORE = "kv";

/** The database name: mist's own prefix, so it never opens a plugin's own `evi-<id>` database */
export const storageName = (id: string, userId?: string) => userId === undefined ? `mist-api:${id}` : `mist-api:${id}:account:${userId}`;

function factory(name: string): IDBFactory {
    let idb: IDBFactory | undefined;
    try {
        idb = globalThis.indexedDB;
    } catch (err) {
        throw new Error(`IndexedDB isn't available on this page, so ${name} can't be opened: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!idb) throw new Error(`IndexedDB isn't available on this page, so ${name} can't be opened`);
    return idb;
}

function connect(name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = factory(name).open(name, 1);
        request.onupgradeneeded = () => void request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error(`Couldn't open ${name}`));
        request.onblocked = () => reject(new Error(`Opening ${name} is blocked by another connection to it that won't close`));
    });
}

function store(name: string): KeyValueStore {
    let db: Promise<IDBDatabase> | undefined;

    const open = () => {
        if (db) return db;
        const opening = db = connect(name).then(conn => {
            const forget = () => {
                if (db === opening) db = undefined;
            };
            // Another tab or a deleteDatabase wants the database: let it go, and open again on the next call
            conn.onversionchange = () => {
                conn.close();
                forget();
            };
            conn.onclose = forget;
            return conn;
        }, err => {
            if (db === opening) db = undefined;
            throw err;
        });
        return opening;
    };

    /** Runs `body` in one transaction and settles with its result once the transaction commits */
    async function transact<R>(mode: IDBTransactionMode, body: (kv: IDBObjectStore, done: (result: R) => void, fail: (err: unknown) => void) => void): Promise<R> {
        const conn = await open();
        return new Promise<R>((resolve, reject) => {
            const tx = conn.transaction(STORE, mode);
            let result: R;
            let failure: { err: unknown; } | undefined;
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(failure ? failure.err : tx.error ?? new Error(`A transaction on ${name} was aborted`));
            try {
                body(tx.objectStore(STORE), value => void (result = value), err => {
                    failure = { err };
                    tx.abort();
                });
            } catch (err) {
                failure = { err };
                tx.abort();
            }
        });
    }

    return {
        get: key => transact("readonly", (kv, done, fail) => {
            const request = kv.get(key);
            request.onsuccess = () => {
                try {
                    done(parse(request.result));
                } catch (err) {
                    fail(err);
                }
            };
        }),
        async set(key, value) {
            // Before the transaction, so a value JSON can't write rejects without opening anything
            const json = text(value);
            return transact<void>("readwrite", kv => void kv.put(json, key));
        },
        update: (key, fn) => transact("readwrite", (kv, done, fail) => {
            const request = kv.get(key);
            request.onsuccess = () => {
                try {
                    const next = fn(parse(request.result));
                    // The transaction would commit before the promise settled, storing it as {}. Its own
                    // rejection is dropped: the TypeError is what update rejects with.
                    if (typeof (next as { then?: unknown; } | null)?.then === "function") {
                        Promise.resolve(next).catch(() => { });
                        throw new TypeError(`update's function must be synchronous: it returned a promise for ${JSON.stringify(key)}, so nothing was stored`);
                    }
                    if (next === undefined) {
                        kv.delete(key);
                        return done(undefined);
                    }
                    const json = text(next);
                    kv.put(json, key);
                    done(JSON.parse(json));
                } catch (err) {
                    fail(err);
                }
            };
        }),
        del: key => transact("readwrite", kv => void kv.delete(key)),
        keys: () => transact("readonly", (kv, done) => {
            const request = kv.getAllKeys();
            request.onsuccess = () => done(request.result.map(String));
        }),
        clear: () => transact("readwrite", kv => void kv.clear()),
    };
}

const parse = (stored: unknown) => stored === undefined ? undefined : JSON.parse(stored as string);

function text(value: unknown): string {
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError(`Can't store ${typeof value} as JSON`);
    return json;
}

export function createStorage(id: string): PluginStorage {
    const accounts = new Map<string, KeyValueStore>();
    return {
        ...store(storageName(id)),
        account(userId) {
            if (typeof userId !== "string" || !userId) throw new TypeError(`storage.account needs the account's user id, got ${JSON.stringify(userId)}: no account is signed in yet`);
            let scoped = accounts.get(userId);
            if (!scoped) accounts.set(userId, scoped = store(storageName(id, userId)));
            return scoped;
        },
    };
}
