/** Runs `fn` now, turning a synchronous throw into a rejection */
function begin<T>(fn: () => Promise<T> | T): Promise<T> {
    try {
        return Promise.resolve(fn());
    } catch (err) {
        return Promise.reject(err);
    }
}

/**
 * Wraps `fn` so only one run is in flight: a call during a run gets that run's promise, and the first
 * call after it settles, either way, starts a new run. Nothing is kept once a run settles.
 */
export function shared<T>(fn: () => Promise<T>): () => Promise<T> {
    let current: Promise<T> | undefined;
    return () => {
        if (current) return current;
        const run: Promise<T> = begin(fn).finally(() => {
            if (current === run) current = undefined;
        });
        return current = run;
    };
}

/**
 * `shared` per key: a call gets the run in flight for its first argument, if any, or starts one with
 * all its arguments. Runs for different keys go on side by side.
 */
export function sharedByKey<K extends string | number, A extends unknown[], T>(fn: (key: K, ...args: A) => Promise<T>): (key: K, ...args: A) => Promise<T> {
    const running = new Map<K, Promise<T>>();
    return (key, ...args) => {
        const known = running.get(key);
        if (known) return known;
        const run: Promise<T> = begin(() => fn(key, ...args)).finally(() => {
            if (running.get(key) === run) running.delete(key);
        });
        running.set(key, run);
        return run;
    };
}
