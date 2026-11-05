/** `@aurologic/mist-api/discord`: Discord's accounts, API, router, chat box and language, from the page side. */
import { type ApiMessage, messages, type MessagesOptions, type Rest, restFor } from "./discord/rest.ts";
import type { Mist } from "./index.ts";
import { pluginOf } from "./permissions.ts";

export { accounts, type AccountEvent, type AccountEvents, type SavedAccount, type TokenStatus, whenConnected } from "./discord/accounts.ts";
export { chat } from "./discord/chat.ts";
export { type DurationOptions, type DurationStyle, format } from "./discord/format.ts";
export { avatarUrl, type AvatarOwner, copy, navigate } from "./discord/page.ts";
export { type PermissionFlag, type PermissionKey, PluginPermissionError, UnknownPluginError } from "./permissions.ts";
export { type ApiMessage, DiscordApiError, type MessagesOptions, type Rest, type RestOptions } from "./discord/rest.ts";

export interface DiscordApi {
    rest: Rest;
    messages(channelId: string, options?: MessagesOptions): AsyncGenerator<ApiMessage, void, undefined>;
}

/**
 * Discord's own API client, signed in as the current account, and paging over a channel's messages,
 * for the plugin whose mist object this is: held to the `permissions` in its manifest, as Evi holds
 * its fetch. Throws a TypeError for anything but the plugin's own mist object, after `mist.define`.
 */
export function discord(mist: Mist<any, any>): DiscordApi {
    const id = pluginOf(mist, "discord()");
    return { rest: restFor(id), messages: (channelId, options) => messages(id, channelId, options) };
}
