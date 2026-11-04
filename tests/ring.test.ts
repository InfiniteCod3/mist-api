import { expect, test } from "bun:test";

import { Ring } from "../src/ring";

test("keeps only the newest items, oldest first", () => {
    const ring = new Ring<number>(3);
    for (let i = 1; i <= 5; i++) ring.push(i);
    expect(ring.size).toBe(3);
    expect(ring.last()).toEqual([3, 4, 5]);
    expect(ring.last(2)).toEqual([4, 5]);
    expect(ring.last(0)).toEqual([]);
});

test("refuses a capacity that can't hold anything", () => {
    expect(() => new Ring(0)).toThrow(RangeError);
    expect(() => new Ring(1.5)).toThrow(RangeError);
});
