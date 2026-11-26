import { filters, find } from "@evi/api";

import { assertAppPath } from "../permissions.ts";
import { stores } from "../stores.ts";
import type { WithDiscordNative } from "../util.ts";
import { channelPath } from "./links.ts";
import { snowflake } from "./snowflake.ts";

export interface ChannelTarget {
    /**
     * The channel's server, or null for a DM. Left out, it's read from ChannelStore, and a channel
     * ChannelStore doesn't hold throws.
     */
    guildId?: string | null;
    /** A message to jump to */
    messageId?: string;
}

export interface Navigate {
    /** Goes to a page of Discord's app, as in "/channels/@me" or "/channels/<server>/<channel>", with Discord's router */
    (path: string): void;
    /**
     * Opens a channel, or jumps to a message in it. Takes what parseMessageLink reads, as in
     * `navigate.channel(link.channelId, link)`.
     */
    channel(channelId: string, target?: ChannelTarget): void;
}

function goTo(path: string) {
    assertAppPath("navigate", path, "path");
    // Looked up on each call, not kept: a hook another plugin puts on the router later still runs
    const transitionTo = find<(path: string) => void>(filters.byCode("transitionTo - Transitioning to"));
    if (typeof transitionTo !== "function") throw new Error("navigate: Discord's navigation isn't available");
    transitionTo(path);
}

/** The channel's server as ChannelStore holds it, null for a DM. A guess for a channel it doesn't hold would open the wrong page. */
function guildOf(channelId: string): string | null {
    const channel = stores.channel?.getChannel(channelId);
    if (!channel) throw new Error(`navigate.channel: channel ${channelId} isn't in ChannelStore; pass guildId (or null for a DM)`);
    return channel.guild_id ?? null;
}

export const navigate: Navigate = Object.assign(goTo, {
    channel(channelId: string, { guildId, messageId }: ChannelTarget = {}): void {
        snowflake.assert(channelId, "navigate.channel: channelId");
        goTo(channelPath("navigate.channel", guildId === undefined ? guildOf(channelId) : guildId, channelId, messageId));
    },
});

export interface AvatarOwner {
    id: string;
    avatar?: string | null;
    /** "0" or missing for accounts with the new usernames */
    discriminator?: string | null;
}

/** The CDN's sizes are powers of two from 16 to 4096 */
const cdnSize = (size: number) => 2 ** Math.min(12, Math.max(4, Math.ceil(Math.log2(Number.isFinite(size) && size > 0 ? size : 128))));

/**
 * The URL of a user's avatar on Discord's CDN at `size` pixels or the next size up, as a still image.
 * Without an uploaded avatar, Discord's default one for them.
 */
export function avatarUrl(user: AvatarOwner, size = 128): string {
    if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=${cdnSize(size)}`;
    const legacy = user.discriminator && user.discriminator !== "0" && /^\d+$/.test(user.discriminator);
    // Discord's rule: new usernames pick from six by the id's timestamp bits, legacy tags from five by the tag
    let index = 0;
    if (legacy) index = Number(user.discriminator) % 5;
    else if (snowflake.is(user.id)) index = Number((BigInt(user.id) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/**
 * Copies text with Discord's desktop clipboard, or the browser's where there's none. Written out here,
 * not behind a helper: Evi's store review then finds `DiscordNative.clipboard` and
 * `clipboard.writeText` in the bundle of a plugin that imports it.
 */
export async function copy(text: string): Promise<void> {
    const desktop = (window as WithDiscordNative).DiscordNative?.clipboard;
    if (typeof desktop?.copy === "function") return desktop.copy(text);
    await navigator.clipboard.writeText(text);
}
