/** Text formatting the CLI's commands share */
// bin/ imports nothing from src/: tsconfig.bin.json compiles bin/ alone, to dist/bin

/** What a caught value says: an Error's message, or the value as text */
export const errorText = (err: unknown) => err instanceof Error ? err.message : String(err);

/** A record's time as hh:mm:ss.mmm in the local zone */
export const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false }) + "." + String(at % 1000).padStart(3, "0");

/** `text` cut to `max` characters, with an ellipsis */
export const clip = (text: string, max = 300) => text.length > max ? `${text.slice(0, max)}…` : text;

/** Counts by health, as in "2 applied, 1 broken" */
export const healthCounts = (health: Record<string, number>) => Object.entries(health).map(([state, count]) => `${count} ${state}`).join(", ") || "none";

export interface PatchProblem { index: number; health: string; find: string; errors: string[]; }
/** A plugin's patches counted by health, with the ones that went wrong */
export interface PatchHealth { health: Record<string, number>; problems: PatchProblem[]; }

/** `  patches: 2 applied, 1 failed`, then a line for each problem patch */
export function patchHealthLines({ health, problems }: PatchHealth): string[] {
    return [
        `  patches: ${healthCounts(health)}`,
        ...problems.map(problem => `    #${problem.index} ${problem.health} find ${problem.find}${problem.errors.length ? `: ${problem.errors.join("; ")}` : ""}`),
    ];
}

/** Why a watch the CLI kept in the page is gone */
export const watchEndedMessage = (ttlMs: number) =>
    `The page ended the watch: it reloaded, or the CLI didn't read it for ${ttlMs >= 1000 ? `${ttlMs / 1000} seconds` : `${ttlMs} ms`}`;
