import { checkNumber } from "./internal.ts";

/** Keeps the last `capacity` items pushed, oldest first */
export class Ring<T> {
    private readonly items: T[] = [];

    constructor(readonly capacity: number) {
        checkNumber("Ring", "capacity", capacity, { min: 1, integer: true });
    }

    push(item: T) {
        this.items.push(item);
        if (this.items.length > this.capacity) this.items.shift();
    }

    /** The newest `n` items, oldest first */
    last(n = this.capacity): T[] {
        return n > 0 ? this.items.slice(-Math.floor(n)) : [];
    }

    count(predicate: (item: T) => boolean) {
        let n = 0;
        for (const item of this.items) if (predicate(item)) n++;
        return n;
    }

    get size() {
        return this.items.length;
    }
}
