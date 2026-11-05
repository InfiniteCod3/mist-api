/**
 * Which plugin's start is running, so a store lookup that comes back empty can be pinned on it. Evi
 * calls each start in turn and the next one only after it returns or reaches its first await, so
 * during the synchronous part exactly one start runs. After an await, any plugin's code may run.
 */
let onMiss: ((store: string) => void) | undefined;

/** Runs `start`, telling `miss` about each store that `stores` came back without until it returns */
export function whileStarting<R>(miss: (store: string) => void, start: () => R): R {
    const outer = onMiss;
    onMiss = miss;
    try {
        return start();
    } finally {
        onMiss = outer;
    }
}

export const storeMissed = (store: string) => onMiss?.(store);
