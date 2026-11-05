import type { SourcePatch } from "@evi/api";

import { onDemand } from "../patches.ts";
import type { Channel } from "../stores.ts";
import type { Message } from "./registries.ts";
import { insertOnce, logOnce, type Owned, type Owner, owned, shared, uiRef } from "./shared.ts";

/** A message about to be sent. Change `content` to change what's sent. */
export interface SendDraft {
    readonly channel: Channel;
    content: string;
}

/** An edit about to be saved. Change `content` to change what's saved. */
export interface EditDraft extends SendDraft {
    /** The message as it is now */
    readonly message: Message;
}

/** Return `{ cancel: true }` to stop the message: Discord keeps it in the text box */
export type Verdict = void | { cancel: boolean; };

export type Listener<D> = (draft: D) => Verdict | Promise<Verdict>;

interface Hook<D> {
    readonly key: string;
    readonly owner: Owned;
    readonly listener: Listener<D>;
}

interface OutgoingState {
    readonly protocol: 1;
    readonly send: Map<string, Hook<SendDraft>>;
    readonly edit: Map<string, Hook<EditDraft>>;
    /**
     * What the patched send and edit call. False at once with no listeners, so a plain send isn't
     * delayed; otherwise a promise of whether a listener cancelled.
     */
    beforeSend(draft: SendDraft): false | Promise<boolean>;
    beforeEdit(draft: EditDraft): false | Promise<boolean>;
}

const OUTGOING = "outgoing";

/** Listeners in key order, one at a time. A listener that throws is logged and skipped. */
async function run<D extends SendDraft>(hooks: Map<string, Hook<D>>, draft: D): Promise<boolean> {
    for (const hook of [...hooks.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) {
        const before = draft.content;
        try {
            const verdict = await hook.listener(draft);
            if (typeof draft.content !== "string") {
                draft.content = before;
                logOnce(hook.owner.log, `${hook.key} set the message's content to something other than a string; keeping the content it had`, new TypeError(typeof draft.content));
            }
            if (verdict?.cancel) return true;
        } catch (err) {
            if (typeof draft.content !== "string") draft.content = before;
            logOnce(hook.owner.log, `${hook.key} threw before a message went out; the message goes on`, err);
        }
    }
    return false;
}

const outgoing = () => shared<OutgoingState>(OUTGOING, () => {
    const state: Omit<OutgoingState, "beforeSend" | "beforeEdit"> = { protocol: 1, send: new Map(), edit: new Map() };
    return Object.assign(state, {
        beforeSend: (draft: SendDraft) => state.send.size > 0 && run(state.send, draft),
        beforeEdit: (draft: EditDraft) => state.edit.size > 0 && run(state.edit, draft),
    });
}, s => s.send instanceof Map && s.edit instanceof Map);

function addHook<D>(hooks: Map<string, Hook<D>>, owner: Owner, id: string, listener: Listener<D>) {
    if (!id) throw new Error("mist ui: a message hook needs an id");
    const by = owned(owner);
    const hook: Hook<D> = { key: `${by.id}/${id}`, owner: by, listener };
    hooks.set(hook.key, hook);
    const remove = () => {
        if (hooks.get(hook.key) === hook) hooks.delete(hook.key);
    };
    by.onDispose(remove);
    return remove;
}

const ref = uiRef(OUTGOING);

export const messages = {
    /** Put these in the plugin's `patches` */
    patches: [
        onDemand({
            // The chat box's handleSendMessage checks the message, then reads its content (checked 2026-11-05):
            //   return(0,nA.i)({…,channel:h}).then(e=>{let{valid:s,failureReason:A}=e;if(!s)if(…)…;else return{shouldClear:!1,shouldRefocus:!1};let f=(0,tD.S)(t,{channel:h,isEdit:!1});
            // The listeners run between the two, so a changed content goes through Discord's own handling.
            // Cancelling answers what an invalid message does: the text stays in the box.
            find: ".handleSendMessage,onResize:",
            replace: {
                match: /\.then\((?:async )?(\i)=>\{(let\{valid:(\i),failureReason:\i\}=\1;if\(!\3\).{0,1000}?)(?=let \i=\(0,\i\.\i\)\((\i),\{channel:(\i),isEdit:!1\}\))/,
                with: insertOnce(`${ref}?.beforeSend`, (_, [result, checks, , content, channel]) =>
                    `.then(async ${result}=>{${checks}let $mistDraft={channel:${channel},content:${content}},$mistWait=${ref}?.beforeSend?.($mistDraft);` +
                    `if($mistWait&&await $mistWait)return{shouldClear:!1,shouldRefocus:!0};${content}=$mistDraft.content;`),
            },
        }),
        onDemand({
            // The message editor's onSubmit checks the edit, then reads its content (checked 2026-11-05):
            //   u({value:e,channel:n,message:t}).then(s=>{let{valid:u}=s;if(!u)return Promise.resolve({shouldClear:!1,shouldRefocus:!1});let d=(0,l.S)(e,{channel:n,isEdit:!0});
            find: "isEdit:!0",
            replace: {
                match: /(?<=\{value:\i,channel:\i,message:(\i)\}\))\.then\((?:async )?(\i)=>\{(let\{valid:(\i)\}=\2;if\(!\4\).{0,1000}?)(?=let \i=\(0,\i\.\i\)\((\i),\{channel:(\i),isEdit:!0\}\))/,
                with: insertOnce(`${ref}?.beforeEdit`, (_, [message, result, checks, , content, channel]) =>
                    `.then(async ${result}=>{${checks}let $mistDraft={channel:${channel},message:${message},content:${content}},$mistWait=${ref}?.beforeEdit?.($mistDraft);` +
                    `if($mistWait&&await $mistWait)return Promise.resolve({shouldClear:!1,shouldRefocus:!0});${content}=$mistDraft.content;`),
            },
        }),
    ] as SourcePatch[],
    /**
     * Runs `listener` before each message the user sends from the chat box, while the plugin runs.
     * Listeners run one at a time in plugin and id order and may be async; the message waits for them.
     */
    beforeSend(owner: Owner, id: string, listener: Listener<SendDraft>): () => void {
        return addHook(outgoing().send, owner, id, listener);
    },
    /** Runs `listener` before each edit the user saves, while the plugin runs */
    beforeEdit(owner: Owner, id: string, listener: Listener<EditDraft>): () => void {
        return addHook(outgoing().edit, owner, id, listener);
    },
};
