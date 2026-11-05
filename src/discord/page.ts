import { filters, find } from "@evi/api";

import type { WithDiscordNative } from "../util.ts";

/** Goes to a page of Discord's app, as in "/channels/@me" or "/channels/<server>/<channel>", with Discord's own router */
export function navigate(path: string): void {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
        throw new TypeError(`A Discord path starts with one /, as in "/channels/@me", got ${JSON.stringify(path)}`);
    }
    const transitionTo = find<(path: string) => void>(filters.byCode("transitionTo - Transitioning to"));
    if (typeof transitionTo !== "function") throw new Error("Discord's navigation isn't available");
    transitionTo(path);
}

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
 * Without an avatar of their own, Discord's default one for them.
 */
export function avatarUrl(user: AvatarOwner, size = 128): string {
    if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=${cdnSize(size)}`;
    const legacy = user.discriminator && user.discriminator !== "0" && /^\d+$/.test(user.discriminator);
    // Discord's rule: new usernames pick from six by the id's timestamp bits, legacy tags from five by the tag
    const index = legacy ? Number(user.discriminator) % 5 : /^\d+$/.test(user.id) ? Number((BigInt(user.id) >> 22n) % 6n) : 0;
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/**
 * Copies text with Discord's desktop clipboard, or the browser's where there's none. Written out here,
 * rather than behind a helper, so Evi's store review finds `DiscordNative.clipboard` and
 * `clipboard.writeText` in the bundle of a plugin that imports it.
 */
export async function copy(text: string): Promise<void> {
    const desktop = (window as WithDiscordNative).DiscordNative?.clipboard;
    if (typeof desktop?.copy === "function") return desktop.copy(text);
    await navigator.clipboard.writeText(text);
}
