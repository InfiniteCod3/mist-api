import type { EviDebug, Registry } from "./registry.ts";

/** Bus protocols a plugin provides, each at one version, as in `{ "weather-feed": 2 }` */
export type Provides = Readonly<Record<string, number>>;

/** A protocol this plugin speaks with another plugin, at the version it speaks */
export interface Need {
    /** The other plugin's id, from its manifest.json */
    readonly plugin: string;
    readonly protocol: string;
    readonly version: number;
}

/** Which side the user has to update, when the two plugins speak different versions */
export interface Mismatch {
    need: Need;
    /** The other plugin's name, from its manifest */
    name: string;
    /** The version it provides, or undefined when it says nothing about the protocol */
    provided: number | undefined;
    /** "other" when the other plugin is behind or says nothing, "this" when it is ahead */
    update: "other" | "this";
}

export function checkProvides(provides: Provides) {
    for (const [protocol, version] of Object.entries(provides)) {
        if (!protocol || !Number.isInteger(version) || version < 1) throw new Error(`mist: provides needs a protocol name and a whole version from 1 (${protocol}: ${version})`);
    }
}

/**
 * The needs that the installed plugins don't meet. A plugin that isn't installed, or that Evi hasn't
 * evaluated (it is turned off), isn't judged: until its code runs, it can't have said what it provides.
 */
export function mismatches(needs: readonly Need[], evi: EviDebug | undefined, registry: Registry): Mismatch[] {
    const out: Mismatch[] = [];
    for (const need of needs) {
        let info;
        try { info = evi?.plugins?.get(need.plugin); } catch { continue; }
        // An Evi without `evaluated` only tells running plugins apart
        if (!info || !(info.evaluated ?? info.running)) continue;
        const handle = registry.get(need.plugin);
        let provided: number | undefined;
        try {
            const version = handle?.provides?.[need.protocol];
            provided = typeof version === "number" ? version : undefined;
        } catch { }
        if (provided === need.version) continue;
        out.push({ need, name: info.manifest?.name || need.plugin, provided, update: provided !== undefined && provided > need.version ? "this" : "other" });
    }
    return out;
}

/** The status and log line for a mismatch */
export function describeMismatch({ need, name, provided, update }: Mismatch, self: string): string {
    const has = provided === undefined ? `doesn't say it provides ${need.protocol}` : `provides ${need.protocol} version ${provided}`;
    return `${name} (${need.plugin}) ${has}, and ${self} speaks version ${need.version}: update ${update === "other" ? name : self}`;
}

/** The toast: which plugin to update, in the user's terms */
export function toastFor({ name, update }: Mismatch, self: string): string {
    return update === "other"
        ? `${self} needs a newer version of ${name}. Update ${name} to use them together.`
        : `${name} is newer than ${self} supports. Update ${self} to use them together.`;
}
