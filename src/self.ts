/**
 * Checks the `$self` names in a definition's source patches against the definition. Evi rewrites
 * `$self` to the plugin's definition, so a misspelt name is undefined inside Discord's code, and a
 * call of it is a TypeError there, far from the patch.
 */

const SELF = /\$self(?:\?\.|\.)([A-Za-z_$][\w$]*)(\s*(?:\?\.\s*)?\()?/g;

interface Replacement { with?: unknown; }
interface Patch { replace?: Replacement | readonly Replacement[]; }

/** One line per `$self` name that the definition lacks or calls without having a function by it */
export function checkSelf(definition: Record<string, unknown>): string[] {
    const patches = Array.isArray(definition.patches) ? definition.patches as Patch[] : [];
    const lines = new Set<string>();
    patches.forEach((patch, index) => {
        for (const replacement of [patch?.replace ?? []].flat()) {
            const text = replacement?.with;
            if (typeof text !== "string") continue;
            for (const [, name, call] of text.matchAll(SELF)) {
                const has = Object.hasOwn(definition, name);
                if (has && (!call || typeof definition[name] === "function")) continue;
                const what = call ? `calls $self.${name}, but the definition has no function ${name}, so Discord's code gets undefined there` : `reads $self.${name}, but the definition has no ${name}, so Discord's code gets undefined there`;
                const near = nearest(name, Object.keys(definition).filter(key => typeof definition[key] === "function"));
                lines.add(`patches[${index}] ${what}${near ? `. Did you mean ${near}?` : ""}`);
            }
        }
    });
    return [...lines];
}

/** The one name within two edits of `name`, if exactly one is */
function nearest(name: string, names: string[]) {
    const close = names.filter(other => other !== name && distance(name.toLowerCase(), other.toLowerCase()) <= 2);
    return close.length === 1 ? close[0] : undefined;
}

function distance(a: string, b: string) {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const next = [i];
        for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        row = next;
    }
    return row[b.length];
}
