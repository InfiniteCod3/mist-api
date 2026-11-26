import { filters, findAll } from "@evi/api";

import { lookup, stores } from "../stores.ts";

/** Discord's ComponentDispatch: an event emitter its components listen on */
interface ComponentDispatch {
    hasSubscribers(event: string): boolean;
    dispatchToLastSubscribed(event: string, payload: unknown): unknown;
}

const isComponentDispatch = (value: unknown): value is ComponentDispatch =>
    typeof (value as ComponentDispatch | null)?.dispatchToLastSubscribed === "function" && typeof (value as ComponentDispatch).hasSubscribers === "function";

function listens(dispatch: ComponentDispatch) {
    try {
        return dispatch.hasSubscribers("INSERT_TEXT");
    } catch {
        return false;
    }
}

interface MessageActions {
    sendBotMessage?(channelId: string, content: string): void;
}

// Made on first use: importing this module then doesn't call into @evi/api
let messageActions: (() => MessageActions | undefined) | undefined;

export const chat = {
    /**
     * Types `text` into the message box at the cursor. Nothing is sent. False when no message box is open.
     */
    insertText(text: string): boolean {
        // Discord makes more than one ComponentDispatch; the message box listens on one of them
        const box = findAll<ComponentDispatch>(isComponentDispatch).find(listens);
        if (!box) return false;
        box.dispatchToLastSubscribed("INSERT_TEXT", { plainText: text, rawText: text });
        return true;
    },

    /**
     * Shows `text` in a channel as Discord's "Only you can see this" message. Nothing is sent, and it's
     * gone on reload. The channel defaults to the one open.
     */
    localMessage(text: string, channelId: string | undefined = stores.selectedChannel?.getChannelId()): void {
        if (!channelId) throw new Error("chat.localMessage: no channel is open to show the message in");
        messageActions ??= lookup<MessageActions>(filters.byProps("sendBotMessage", "sendMessage"));
        const actions = messageActions();
        if (typeof actions?.sendBotMessage !== "function") throw new Error("chat.localMessage: Discord's local messages aren't available");
        actions.sendBotMessage(channelId, text);
    },
};
