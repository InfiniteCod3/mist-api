import { I18n } from "@evi/api";

/** Discord's language tag, as in "en-US" or "pt-BR": the one picked in Discord's Language settings */
const locale = () => I18n.discordLocale;

type Kept = Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.NumberFormat | Intl.ListFormat | DurationFormat;
// Making a formatter costs far more than using one, and a list formats a time per row
const kept = new Map<string, Kept>();

function keep<T extends Kept>(kind: string, options: object, make: (tag: string) => T): T {
    const tag = locale();
    const key = `${kind}|${tag}|${JSON.stringify(options)}`;
    let made = kept.get(key) as T | undefined;
    if (!made) kept.set(key, made = make(tag));
    return made;
}

type DurationUnit = "days" | "hours" | "minutes" | "seconds";

/** Intl.DurationFormat, which TypeScript's ES2023 lib doesn't have yet */
interface DurationFormat {
    format(duration: Partial<Record<DurationUnit, number>>): string;
}
type DurationFormatConstructor = new (locale: string, options: { style: DurationStyle; }) => DurationFormat;

export type DurationStyle = "long" | "short" | "narrow";

export interface DurationOptions {
    /** "1 hour, 5 minutes", "1 hr, 5 min" or "1h 5m". Default "long". */
    style?: DurationStyle;
    /** How many units, from the largest that isn't 0. Default 2: "1 day, 3 hours", not "1 day, 3 hours, 12 minutes". */
    units?: number;
}

const DURATION_UNITS: readonly [DurationUnit, number][] = [["days", 86_400_000], ["hours", 3_600_000], ["minutes", 60_000], ["seconds", 1000]];

/** The duration split into the units to show, the smaller ones dropped */
export function durationParts(ms: number, units = 2): Partial<Record<DurationUnit, number>> {
    let rest = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    const counts = DURATION_UNITS.map(([unit, size]) => {
        const count = Math.floor(rest / size);
        rest -= count * size;
        return [unit, count] as const;
    });
    const first = counts.findIndex(([, count]) => count > 0);
    if (first < 0) return { seconds: 0 };
    return Object.fromEntries(counts.slice(first, first + Math.max(1, Math.floor(units))).filter(([, count]) => count > 0));
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3600], ["minute", 60],
];

const time = (value: number | Date | string) => value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : value;

export const format = {
    /** Discord's language tag, which every format here uses */
    locale,

    /** A timer's reading: "4:05", "1:02:03". Below 0 counts as 0. */
    clock(ms: number): string {
        const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
        const one = keep("number", { useGrouping: false }, tag => new Intl.NumberFormat(tag, { useGrouping: false }));
        const two = keep("number", { minimumIntegerDigits: 2, useGrouping: false }, tag => new Intl.NumberFormat(tag, { minimumIntegerDigits: 2, useGrouping: false }));
        const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
        return hours ? `${one.format(hours)}:${two.format(minutes)}:${two.format(seconds)}` : `${one.format(minutes)}:${two.format(seconds)}`;
    },

    /** A length of time in words: "1 hour, 5 minutes" */
    duration(ms: number, { style = "long", units = 2 }: DurationOptions = {}): string {
        const parts = Object.entries(durationParts(ms, units));
        const unit = ([plural, count]: (typeof parts)[number]) => {
            const singular = plural.slice(0, -1);
            return keep("unit", { singular, style }, tag => new Intl.NumberFormat(tag, { style: "unit", unit: singular, unitDisplay: style })).format(count);
        };
        // DurationFormat leaves out a 0, so it would write nothing for "0 seconds"
        if (parts.every(([, count]) => count === 0)) return unit(["seconds", 0]);
        const Duration = (Intl as { DurationFormat?: DurationFormatConstructor; }).DurationFormat;
        if (Duration) return keep("duration", { style }, tag => new Duration(tag, { style })).format(Object.fromEntries(parts));
        return keep("list", { style }, tag => new Intl.ListFormat(tag, { type: "unit", style })).format(parts.map(unit));
    },

    /** How long ago, or how long until: "5 minutes ago", "yesterday", "in 2 hours", "now" */
    ago(at: number | Date | string, now: number = Date.now()): string {
        const relative = keep("relative", {}, tag => new Intl.RelativeTimeFormat(tag, { numeric: "auto" }));
        const seconds = (time(at) - now) / 1000;
        if (!Number.isFinite(seconds)) return String(new Date(NaN));
        for (const [unit, size] of RELATIVE_UNITS) {
            if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
        }
        return relative.format(0, "second");
    },

    /** A date, a time, or both, as `options` asks. Default: the date, as in "4 Nov 2026". */
    date(at: number | Date | string, options: Intl.DateTimeFormatOptions = { dateStyle: "medium" }): string {
        const when = new Date(time(at));
        if (Number.isNaN(when.getTime())) return String(when);
        return keep("date", options, tag => new Intl.DateTimeFormat(tag, options)).format(when);
    },
};
