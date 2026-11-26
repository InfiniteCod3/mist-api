import { stores } from "../stores.ts";

/** A user as Discord's stores hold it (`globalName`) or as its API sends it (`global_name`) */
export interface NamedUser {
    id?: string;
    globalName?: string | null;
    global_name?: string | null;
    username?: string | null;
}

export interface DisplayNameOptions {
    /** A server whose nickname for the user comes first */
    guildId?: string | null;
    /** What to show when there's no name to read. Default "" */
    fallback?: string;
}

/**
 * The name Discord shows for a user: their nickname in `guildId`, else the nickname you gave them as
 * a friend, else their display name, else their username. A user id is looked up in UserStore.
 */
export function displayName(user: string | NamedUser | null | undefined, { guildId, fallback = "" }: DisplayNameOptions = {}): string {
    const id = typeof user === "string" ? user : user?.id;
    const named: NamedUser | undefined = typeof user === "string" ? stores.user?.getUser(user) : user ?? undefined;
    const guildNick = guildId && id ? stores.guildMembers?.getNick(guildId, id) : undefined;
    if (guildNick) return guildNick;
    const friendNick = id ? stores.relationships?.getNickname?.(id) : undefined;
    return friendNick || named?.globalName || named?.global_name || named?.username || fallback;
}
