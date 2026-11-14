/**
 * A runner that lets at most `n` of the functions given to it run at once; the others wait their turn
 * in the order they came. `run(fn)` settles as `fn`'s promise does.
 */
export function limit(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
    if (!(Number.isInteger(n) && n > 0)) throw new TypeError(`limit takes a whole number above 0, got ${n}`);
    const waiting: (() => void)[] = [];
    let running = 0;
    const done = () => {
        running--;
        waiting.shift()?.();
    };
    return fn => new Promise((resolve, reject) => {
        const start = () => {
            running++;
            let result;
            try {
                result = Promise.resolve(fn());
            } catch (err) {
                result = Promise.reject(err);
            }
            result.then(resolve, reject).finally(done);
        };
        if (running < n) start();
        else waiting.push(start);
    });
}
