const isId = (value: unknown): value is string => typeof value === "string" && /^\d{1,20}$/.test(value);

/** Where a Discord link leads: a server's channel (or a DM, with `guildId` null) and maybe one message in it */
export interface MessageLink {
    guildId: string | null;
    channelId: string;
    messageId?: string;
}

/**
 * The link Discord's "Copy Message Link" makes: `https://discord.com/channels/<server or @me>/<channel>/<message>`.
 * Without `messageId`, the channel's link. `guildId` null is a DM or group DM.
 */
export function messageLink(guildId: string | null, channelId: string, messageId?: string): string {
    if (guildId !== null && !isId(guildId)) throw new TypeError(`A server id is a Discord id or null for a DM, got ${JSON.stringify(guildId)}`);
    if (!isId(channelId)) throw new TypeError(`A channel id is a Discord id, got ${JSON.stringify(channelId)}`);
    if (messageId !== undefined && !isId(messageId)) throw new TypeError(`A message id is a Discord id, got ${JSON.stringify(messageId)}`);
    return `https://discord.com/channels/${guildId ?? "@me"}/${channelId}${messageId ? `/${messageId}` : ""}`;
}

const LINK = /^(?:https?:\/\/)?(?:(?:www|ptb|canary)\.)?discord(?:app)?\.com\/channels\/(@me|\d{1,20})\/(\d{1,20})(?:\/(\d{1,20}))?\/?(?:[?#]\S*)?$/i;

/**
 * Reads a message or channel link of discord.com, ptb., canary. or discordapp.com, with or without
 * https://, as a user pastes it: spaces and <> around it are ignored. Null for anything else.
 */
export function parseMessageLink(text: string): MessageLink | null {
    if (typeof text !== "string") return null;
    const match = LINK.exec(text.trim().replace(/^<(.*)>$/, "$1"));
    if (!match) return null;
    const [, guild, channelId, messageId] = match;
    return { guildId: guild === "@me" ? null : guild, channelId, ...messageId && { messageId } };
}
