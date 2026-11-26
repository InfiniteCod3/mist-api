import { filters, find, React, type SourcePatch } from "@evi/api";
import type { ComponentType, MouseEvent, ReactElement, ReactNode } from "react";

import { onDemand } from "../patches.ts";
import type { Channel, Message } from "../stores.ts";
import { Boundary, type Fallback } from "./boundary.ts";
import { byKey, entryOwner, insertOnce, instanceIds, type MistOwner, notify, type Owned, uiRef, uiState } from "./shared.ts";

export type { Message } from "../stores.ts";

interface Entry<P extends object> {
    /** `<plugin id>/<entry id>`: entries render in this order, whatever order plugins start in */
    readonly key: string;
    readonly Component: ComponentType<P>;
    readonly owner: Owned;
    readonly fallback: Fallback | undefined;
}

interface ListState<P extends object> {
    readonly protocol: 1;
    readonly entries: Map<string, Entry<P>>;
    readonly listeners: Set<() => void>;
    /** A new array on each change, for useSyncExternalStore */
    list: readonly Entry<P>[];
}

export interface EntryOptions {
    /**
     * Shown if the entry throws while rendering. Leaving it out, or undefined, shows nothing for a
     * button, where a notice wouldn't fit, and Boundary's notice for an accessory.
     */
    fallback?: Fallback;
}

function listState<P extends object, F extends object>(name: string, calls: (render: (props: P) => ReactElement) => F) {
    return uiState<ListState<P> & F>(name, () => {
        const state: ListState<P> = { protocol: 1, entries: new Map(), listeners: new Set(), list: [] };
        const listen = (listener: () => void) => {
            state.listeners.add(listener);
            return () => void state.listeners.delete(listener);
        };
        const read = () => state.list;
        const idOf = instanceIds();
        function MistEntries({ props }: { props: P; }) {
            const list = React.useSyncExternalStore(listen, read);
            // Keyed per add: an entry a reload added again under its id starts with a fresh boundary
            return React.createElement(React.Fragment, null, ...list.map(entry =>
                React.createElement(Boundary, { key: `${entry.key}#${idOf(entry)}`, name: entry.key, mist: entry.owner, fallback: entry.fallback },
                    React.createElement(entry.Component, props))));
        }
        MistEntries.displayName = `MistEntries(${name})`;
        const render = (props: P) => React.createElement(MistEntries, { key: `mist-api.ui/${name}`, props });
        return Object.assign(state, calls(render));
    }, s => s.entries instanceof Map && s.listeners instanceof Set && Array.isArray(s.list));
}

function changed<P extends object>(fn: string, state: ListState<P>) {
    state.list = [...state.entries.values()].sort(byKey);
    notify(fn, state.listeners);
}

function addEntry<P extends object>(fn: string, state: ListState<P>, by: Owned, id: string, Component: ComponentType<P>, fallback: Fallback | undefined) {
    if (!id) throw new TypeError(`${fn}: id must be a non-empty string`);
    const entry: Entry<P> = { key: `${by.id}/${id}`, Component, owner: by, fallback };
    state.entries.set(entry.key, entry);
    changed(fn, state);
    // Removes this entry only: a newer run of the plugin may have replaced it under the same key
    const remove = () => {
        if (state.entries.get(entry.key) !== entry) return;
        state.entries.delete(entry.key);
        changed(fn, state);
    };
    by.onDispose(remove);
    return remove;
}

/** A lookup of Discord's code, kept once found; a miss is searched again at most every 10 seconds */
function throttledLookup<T>(search: () => T | undefined): () => T | undefined {
    let value: T | undefined;
    let missedAt = -Infinity;
    return () => {
        if (value !== undefined || performance.now() - missedAt < 10_000) return value;
        try {
            value = search();
        } catch {
            value = undefined;
        }
        if (value === undefined) missedAt = performance.now();
        return value;
    };
}

/** What Discord gives its chat bar buttons. `type.analyticsName` is "normal" in a channel's chat bar. */
export interface ChatBarProps {
    channel: Channel;
    disabled?: boolean;
    type?: { analyticsName?: string; };
    [key: string]: unknown;
}

const CHAT_BAR = "chat-bar";

const chatBarState = () => listState<ChatBarProps, { inject(buttons: unknown, props: ChatBarProps): void; }>(CHAT_BAR, render => ({
    inject(buttons, props) {
        // An input that has no buttons (some special text boxes) gets none
        if (!Array.isArray(buttons) || !buttons.length || props?.channel == null) return;
        const submit = buttons.findIndex(button => (button as { key?: unknown; } | null)?.key === "submit");
        buttons.splice(submit < 0 ? buttons.length : submit, 0, render(props));
    },
}));

export interface ChatBarButtonProps {
    /** For screen readers, and the tooltip where Discord shows one */
    label: string;
    onClick(event: MouseEvent): void;
    /** Shows the button as on, like Discord's toggles */
    active?: boolean;
    /** The icon, about 20 by 20 pixels */
    children: ReactNode;
}

/** Discord's chat bar button, with the props ChatBarButton gives it */
type DiscordChatButton = ComponentType<{ onClick(event: MouseEvent): void; isActive: boolean; "aria-label": string; sparkle: boolean; children?: ReactNode; }>;

const chatButton = throttledLookup<DiscordChatButton>(() => find(filters.componentByCode("CHAT_INPUT_BUTTON_NOTIFICATION", "sparkle")));

const classNames = (module: unknown): string[] =>
    typeof module === "object" && module !== null ? Object.values(module).filter((c): c is string => typeof c === "string") : [];

/** The CSS module that has a class starting with `prefix` */
const findCssModule = (prefix: string): unknown => find(module => classNames(module).some(c => c.startsWith(prefix)));

/** The wrapper class of Discord's apps button, from the CSS module of its popout icon */
const chatButtonContainer = throttledLookup(() =>
    classNames(findCssModule("channelAppLauncherButtonPopoutIconAnimation_")).find(c => c.startsWith("buttonContainer_")));

/** A button that looks like Discord's gift and sticker buttons; a plain button if Discord renamed those */
export function ChatBarButton({ label, onClick, active = false, children }: ChatBarButtonProps) {
    const Button = chatButton();
    return React.createElement("div", { className: chatButtonContainer() },
        Button
            ? React.createElement(Button, { onClick, isActive: active, "aria-label": label, sparkle: false }, children)
            : React.createElement("button", {
                type: "button",
                onClick,
                "aria-label": label,
                "aria-pressed": active,
                style: { all: "unset", cursor: "pointer", display: "flex", padding: 4, color: active ? "var(--interactive-active)" : "var(--interactive-normal)" },
            }, children));
}

export const chatBar = {
    /**
     * Put these in the plugin's `patches`. Every plugin using the chat bar carries them. The buttons
     * show once, from whichever plugins are on.
     */
    patches: [onDemand({
        // ChannelTextAreaButtons builds its buttons into an array, the send button last (checked 2026-11-26):
        //   q&&F&&$.push((0,i.jsx)(b,{channelId:S.id,type:T},"appLauncher")),ee&&$.push((0,i.jsx)(ed,{onClick:N,disabled:g||j},"submit")),0===$.length)?null:…
        // The call goes after that push and leaves both pushes and the length check alone for other patches.
        find: "\"ChannelTextAreaButtons\"",
        replace: {
            match: /(?<=\i&&(\i)\.push\(\(0,\i\.jsxs?\)\(\i,\{onClick:\i,disabled:[^{}]+\},"submit"\)\))/,
            with: insertOnce(`${uiRef(CHAT_BAR)}?.inject(`, (_, [buttons]) => `,${uiRef(CHAT_BAR)}?.inject(${buttons},arguments[0])`),
        },
    })] as SourcePatch[],
    /**
     * Adds a button to the chat bar, before the send button, while the plugin runs. `id` is unique
     * within the plugin; adding the same id again replaces the button.
     */
    add(mist: MistOwner, id: string, Component: ComponentType<ChatBarProps>, options: EntryOptions = {}): () => void {
        return addEntry("chatBar.add", chatBarState(), entryOwner(mist, "chatBar.add"), id, Component, options.fallback ?? null);
    },
};

/** Discord's hover bar button */
export interface PopoverButtonProps {
    label: string;
    icon: ComponentType<{ className?: string; color?: string; }>;
    onClick(event: MouseEvent): void;
    /** Red, like Delete */
    dangerous?: boolean;
    disabled?: boolean;
    /** A line after the button */
    separator?: boolean;
}

export interface PopoverProps {
    message: Message;
    channel: Channel;
    /** Discord's hover bar button: render it with your label, icon and onClick */
    Button: ComponentType<PopoverButtonProps>;
}

const POPOVER = "popover";

const popoverState = () => listState<PopoverProps, { render(Button: PopoverProps["Button"], channel: Channel, message: Message): ReactElement; }>(POPOVER, render => ({
    render: (Button, channel, message) => render({ Button, channel, message }),
}));

export const popover = {
    /** Put these in the plugin's `patches` */
    patches: [onDemand({
        // The hover bar lists the Shift-only buttons first, then the rest (checked 2026-11-26):
        //   children:[x?(0,a.jsxs)(a.Fragment,{children:[l&&N?(0,a.jsx)(ni.qv,{label:…,icon:tP.L,onClick:e=>(0,t_.DT)(t,n,e)},"copy-id"):null, … ,"reply-self"):null]}):null,h?…
        // The call goes right after the Shift-only group, with the button component, channel and message from the copy-id button.
        find: ",\"copy-id\")",
        replace: {
            match: /(?<=\(0,\i\.jsxs?\)\((\i\.\i),\{label:[^{}]{0,200},onClick:\i=>\(0,\i\.\i\)\((\i),(\i),\i\)\},"copy-id"\):null,.{0,3000}?\]\}\):null,)/,
            with: insertOnce(`${uiRef(POPOVER)}?.render(`, (_, [Button, channel, message]) => `${uiRef(POPOVER)}?.render(${Button},${channel},${message}),`),
        },
    })] as SourcePatch[],
    /**
     * Adds a button to the hover bar of every message while the plugin runs. Render `props.Button`.
     * It sees each message: the plugin's manifest must declare readMessages, or nothing.
     */
    add(mist: MistOwner, id: string, Component: ComponentType<PopoverProps>, options: EntryOptions = {}): () => void {
        return addEntry("popover.add", popoverState(), entryOwner(mist, "popover.add", { reads: true }), id, Component, options.fallback ?? null);
    },
};

export interface AccessoryProps {
    message: Message;
    channel: Channel;
}

const ACCESSORIES = "accessories";

const accessoriesState = () => listState<AccessoryProps, { render(props: AccessoryProps): ReactElement; }>(ACCESSORIES, render => ({
    render: props => render({ message: props.message, channel: props.channel }),
}));

export const accessories = {
    /** Put these in the plugin's `patches` */
    patches: [onDemand({
        // The accessories under a message are one array (checked 2026-11-26):
        //   children:[k,S,v,T,R,d,c,j,u,m,h,b,g,f,E,C,_,a,p,A,x,l&&this.renderSuppressConfirmModal(),r&&this.renderRemoveAttachmentConfirmModal(),I,y,N]
        // The call goes after the confirm dialogs, before the safety notices. `this.props` holds the message and its channel.
        find: "renderSuppressConfirmModal",
        replace: {
            match: /(?<=\i&&this\.renderRemoveAttachmentConfirmModal\(\))/,
            with: insertOnce(`${uiRef(ACCESSORIES)}?.render(`, () => `,${uiRef(ACCESSORIES)}?.render(this.props)`),
        },
    })] as SourcePatch[],
    /**
     * Adds UI under every message while the plugin runs. Return null for messages it isn't for. It
     * sees each message: the plugin's manifest must declare readMessages, or nothing.
     */
    add(mist: MistOwner, id: string, Component: ComponentType<AccessoryProps>, options: EntryOptions = {}): () => void {
        return addEntry("accessories.add", accessoriesState(), entryOwner(mist, "accessories.add", { reads: true }), id, Component, options.fallback);
    },
};
