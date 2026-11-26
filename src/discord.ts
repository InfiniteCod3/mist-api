/** `@aurologic/mist-api/discord`: Discord's accounts, API, settings, router, chat box and language, from the page side. */
import { type ApiMessage, messages, type MessagesOptions, type Rest, restFor } from "./discord/rest.ts";
import { type CustomStatus, customStatus, type SaveResult, type SettingsProto, type UpdateOptions, updateSettings } from "./discord/settings.ts";
import type { Mist } from "./index.ts";
import { pluginOf } from "./permissions.ts";

export {
    accounts, type AccountEvent, type AccountEvents, type AccountRun, type SavedAccount, type ScopeOptions, type SwitchOptions, type SwitchResult, type TokenStatus, whenConnected,
} from "./discord/accounts.ts";
export { chat } from "./discord/chat.ts";
export { type DurationOptions, type DurationStyle, format } from "./discord/format.ts";
export { type MessageLink, parseMessageLink } from "./discord/links.ts";
export { avatarUrl, type AvatarOwner, type ChannelTarget, copy, type Navigate, navigate } from "./discord/page.ts";
export { type PermissionFlag, type PermissionKey, PluginPermissionError, UnknownPluginError } from "./permissions.ts";
export { type ApiMessage, DiscordApiError, type MessagesOptions, type Rest, type RestOptions } from "./discord/rest.ts";
export type { CustomStatus, SaveResult, SettingsProto, UpdateOptions } from "./discord/settings.ts";
export { snowflake } from "./discord/snowflake.ts";
export { displayName, type DisplayNameOptions, type NamedUser } from "./discord/users.ts";

export interface DiscordApi {
    rest: Rest;
    messages(channelId: string, options?: MessagesOptions): AsyncGenerator<ApiMessage, void, undefined>;
    /** The signed-in account's synced settings, written with Discord's updater */
    settings: {
        /** `G` types the group's value for `change`; left out, it's untyped */
        update<G = any>(proto: SettingsProto, group: string, change: (value: G) => boolean | void, options?: UpdateOptions): Promise<SaveResult>;
    };
    /** The signed-in account's custom status */
    status: {
        get(): CustomStatus | null;
        set(status: CustomStatus | null, options?: UpdateOptions): Promise<SaveResult>;
    };
}

/**
 * Discord's API client and settings updater, signed in as the current account, and paging over a
 * channel's messages, for the plugin whose mist object this is: held to the `permissions` in its
 * manifest, as Evi holds its fetch. Throws a TypeError for anything but the mist object `createMist`
 * made for the plugin.
 */
export function discord(mist: Mist<any, any>): DiscordApi {
    const id = pluginOf(mist, "discord()");
    return {
        rest: restFor(id),
        messages: (channelId, options) => messages(id, channelId, options),
        settings: { update: (proto, group, change, options) => updateSettings(id, proto, group, change, options) },
        status: { get: customStatus.get, set: (status, options) => customStatus.set(id, status, options) },
    };
}
