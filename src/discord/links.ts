import { snowflake } from "./snowflake.ts";

/** Where a Discord link leads: a server's channel (or a DM, with `guildId` null) and maybe one message in it */
export interface MessageLink {
    guildId: string | null;
    channelId: string;
    messageId?: string;
}

/**
 * The app's path to a channel or a message in it: `/channels/<server or @me>/<channel>/<message>`.
 * Throws a TypeError, starting with `fn`, for an id that isn't a Discord id.
 */
export function channelPath(fn: string, guildId: string | null, channelId: string, messageId?: string): string {
    const guild = guildId === null ? "@me" : snowflake.assert(guildId, `${fn}: guildId (or null for a DM)`);
    const channel = snowflake.assert(channelId, `${fn}: channelId`);
    const message = messageId === undefined ? "" : `/${snowflake.assert(messageId, `${fn}: messageId`)}`;
    return `/channels/${guild}/${channel}${message}`;
}

/**
 * The link Discord's "Copy Message Link" makes: `https://discord.com/channels/<server or @me>/<channel>/<message>`.
 * Without `messageId`, the channel's link. `guildId` null is a DM or group DM.
 */
export const messageLink = (guildId: string | null, channelId: string, messageId?: string): string =>
    `https://discord.com${channelPath("format.messageLink", guildId, channelId, messageId)}`;

const LINK = /^(?:https?:\/\/)?(?:(?:www|ptb|canary)\.)?discord(?:app)?\.com\/channels\/(@me|\d{1,20})\/(\d{1,20})(?:\/(\d{1,20}))?\/?(?:[?#]\S*)?$/i;

/**
 * Reads a message or channel link of discord.com, ptb., canary. or discordapp.com, with or without
 * https://, as a user pastes it: spaces and <> around it are ignored. Null for anything else,
 * including an id too large to be Discord's.
 */
export function parseMessageLink(text: string): MessageLink | null {
    if (typeof text !== "string") return null;
    const match = LINK.exec(text.trim().replace(/^<(.*)>$/, "$1"));
    if (!match) return null;
    const [, guild, channelId, messageId] = match;
    const guildId = guild === "@me" ? null : guild;
    const ids = [guildId, channelId, messageId].filter(id => id !== null && id !== undefined);
    if (!ids.every(snowflake.is)) return null;
    return { guildId, channelId, ...messageId && { messageId } };
}
