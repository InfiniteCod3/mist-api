/** `@aurologic/mist-api/discord`: Discord's accounts, API, router, chat box and language, from the page side. */
import { messages, rest } from "./discord/rest.ts";

export { accounts, type AccountEvent, type AccountEvents, type SavedAccount, type TokenStatus, whenConnected } from "./discord/accounts.ts";
export { chat } from "./discord/chat.ts";
export { type DurationOptions, type DurationStyle, format } from "./discord/format.ts";
export { avatarUrl, type AvatarOwner, copy, navigate } from "./discord/page.ts";
export { type ApiMessage, DiscordApiError, type MessagesOptions, type RestOptions } from "./discord/rest.ts";

/** Discord's own API client, signed in as the current account, and paging over a channel's messages */
export const discord = { rest, messages };
