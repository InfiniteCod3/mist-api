/** Set on a patch object by onDemand. The CLI reads it by this name inside the page, so it can't change. */
export const ON_DEMAND = "$mistOnDemand";

/**
 * Marks a source patch whose module is in code Discord downloads only when a screen first opens (a
 * settings screen, a video player). Evi calls such a patch broken until then. mist shows it as waiting,
 * and still as broken when it isn't marked. Returns the same patch.
 */
export function onDemand<P extends object>(patch: P): P {
    return Object.assign(patch, { [ON_DEMAND]: true });
}

/** Evi's health for a patch, with "broken" read as "waiting" for a patch marked onDemand */
export function patchHealth(health: string, patch: unknown): string {
    return health === "broken" && (patch as Record<string, unknown> | undefined)?.[ON_DEMAND] === true ? "waiting" : health;
}
