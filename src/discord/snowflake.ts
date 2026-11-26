import { shownValue } from "../internal.ts";
import { isSnowflake } from "../util.ts";

/** Discord's epoch: the first ms of 2015, in ms since 1970 */
const EPOCH = 1_420_070_400_000n;
/** The bits below an id's time: worker, process and increment */
const TIME_SHIFT = 22n;
/** The latest time an id's 42 time bits hold */
const LAST_MS = EPOCH + (1n << 42n) - 1n;
/** Discord's ids are unsigned 64-bit numbers */
const MAX_ID = (1n << 64n) - 1n;

/** A Discord id: a string of 1 to 20 digits no larger than an unsigned 64-bit number */
const isId = (value: unknown): value is string => isSnowflake(value) && BigInt(value) <= MAX_ID;

function assertId(value: unknown, what: string): string {
    if (!isId(value)) throw new TypeError(`${what} must be a Discord id (1 to 20 digits, at most ${MAX_ID}), got ${shownValue(value)}`);
    return value;
}

const bitsOf = (id: string, what: string) => BigInt(assertId(id, what));

/** Discord's ids, which count up with the time they were made */
export const snowflake = {
    /** Whether `value` is a Discord id: 1 to 20 digits, at most 2^64 - 1 */
    is: isId,

    /**
     * Returns `value` when it is a Discord id. Throws a TypeError, starting with `what`, for anything
     * else: pass where the value came from, as in "kick: userId".
     */
    assert: assertId,

    /** When the id was made, in ms since 1970 */
    time: (id: string): number => Number((bitsOf(id, "snowflake.time: id") >> TIME_SHIFT) + EPOCH),

    /** The smallest id made at `ms`, to page messages from a time with `after` or `before` */
    at(ms: number): string {
        const at = Number.isFinite(ms) ? BigInt(Math.floor(ms)) : undefined;
        if (at === undefined || at < EPOCH || at > LAST_MS) throw new RangeError(`snowflake.at: ms must be a time from 2015 on that an id holds, got ${shownValue(ms)}`);
        return String((at - EPOCH) << TIME_SHIFT);
    },

    /** Sorts ids oldest first: below 0 when `left` is older, above when it's newer */
    compare(left: string, right: string): number {
        const leftBits = bitsOf(left, "snowflake.compare: left");
        const rightBits = bitsOf(right, "snowflake.compare: right");
        if (leftBits < rightBits) return -1;
        if (leftBits > rightBits) return 1;
        return 0;
    },
};
