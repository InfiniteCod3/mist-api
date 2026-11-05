/** `@aurologic/mist-api/discord`: Discord's accounts, API, router, chat box and language, from the page side. */
import { type ApiMessage, messages, type MessagesOptions, type Rest, restFor } from "./discord/rest.ts";

export { accounts, type AccountEvent, type AccountEvents, type SavedAccount, type TokenStatus, whenConnected } from "./discord/accounts.ts";
export { chat } from "./discord/chat.ts";
export { type DurationOptions, type DurationStyle, format } from "./discord/format.ts";
export { avatarUrl, type AvatarOwner, copy, navigate } from "./discord/page.ts";
export { type PermissionFlag, type PermissionKey, PluginPermissionError } from "./discord/permissions.ts";
export { type ApiMessage, DiscordApiError, type MessagesOptions, type Rest, type RestOptions } from "./discord/rest.ts";

export interface DiscordApi {
    rest: Rest;
    messages(channelId: string, options?: MessagesOptions): AsyncGenerator<ApiMessage, void, undefined>;
}

/**
 * Discord's own API client, signed in as the current account, and paging over a channel's messages,
 * for `plugin` (its mist object or id): held to the `permissions` in its manifest, as Evi holds its fetch.
 */
export function discord(plugin: string | { readonly id: string; }): DiscordApi {
    const id = typeof plugin === "string" ? plugin : plugin?.id;
    if (typeof id !== "string" || !id) throw new TypeError(`discord() takes the plugin's mist object or its id, got ${plugin === null ? "null" : typeof plugin}`);
    return { rest: restFor(id), messages: (channelId, options) => messages(id, channelId, options) };
}
