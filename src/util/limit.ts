import { begin, checkNumber } from "../internal.ts";

/**
 * A runner that lets at most `n` of the functions given to it run at once; the others wait their turn
 * in the order they came. `run(fn)` settles as `fn`'s promise does.
 */
export function limit(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
    checkNumber("limit", "n", n, { min: 1, integer: true });
    const waiting: (() => void)[] = [];
    let running = 0;
    const done = () => {
        running--;
        waiting.shift()?.();
    };
    return fn => new Promise((resolve, reject) => {
        const start = () => {
            running++;
            begin(fn).then(resolve, reject).finally(done);
        };
        if (running < n) start();
        else waiting.push(start);
    });
}
