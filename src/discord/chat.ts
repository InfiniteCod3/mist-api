import { filters, find, findAll } from "@evi/api";

import { stores } from "../stores.ts";

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

export const chat = {
    /**
     * Types `text` into the message box at the cursor. Nothing is sent. False when no message box is open.
     */
    insertText(text: string): boolean {
        // Discord makes more than one ComponentDispatch; the message box listens on one of them
        const box = findAll<unknown>(isComponentDispatch).filter(isComponentDispatch).find(listens);
        if (!box) return false;
        box.dispatchToLastSubscribed("INSERT_TEXT", { plainText: text, rawText: text });
        return true;
    },

    /**
     * Shows `text` in a channel as Discord's own "Only you can see this" message. Nothing is sent, and
     * it's gone on reload. The channel defaults to the one open.
     */
    localMessage(text: string, channelId: string | undefined = stores.selectedChannel?.getChannelId()): void {
        if (!channelId) throw new Error("No channel is open to show the message in");
        const actions = find<MessageActions>(filters.byProps("sendBotMessage", "sendMessage"));
        if (typeof actions?.sendBotMessage !== "function") throw new Error("Discord's local messages aren't available");
        actions.sendBotMessage(channelId, text);
    },
};
