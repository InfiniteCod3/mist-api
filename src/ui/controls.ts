/** Settings-panel pieces that look like Discord's, with a fallback of their own when Discord's component is missing. */
// A namespace import, read at render: Discord's React and components exist only once its modules load,
// and a test's mock of @evi/api may have no Components, which a named import would fail to link
import * as evi from "@evi/api";
import type { ComponentType, MouseEvent, ReactElement, ReactNode } from "react";

import { useMistStyles } from "./styles.ts";

export type ButtonVariant = "primary" | "secondary" | "danger" | "link";
export type ButtonSize = "small" | "medium" | "large";

export interface ButtonProps {
    children?: ReactNode;
    onClick?(event: MouseEvent<HTMLButtonElement>): void;
    /** Default "secondary" */
    variant?: ButtonVariant;
    /** Default "small", the size of the buttons in Discord's settings rows */
    size?: ButtonSize;
    disabled?: boolean;
    /** Shows the action is under way: disabled, with Discord's spinner when its button is there */
    busy?: boolean;
    /** The accessible name, for a button whose children don't say what it does */
    label?: string;
    type?: "button" | "submit";
}

/** Discord's legacy Button, as Evi's Components.Button finds it */
type DiscordButton = ComponentType<any> & { Colors?: Record<string, string>; Sizes?: Record<string, string>; };

const COLORS: Record<Exclude<ButtonVariant, "link">, string> = { primary: "BRAND", secondary: "PRIMARY", danger: "RED" };
const SIZES: Record<ButtonSize, string> = { small: "SMALL", medium: "MEDIUM", large: "LARGE" };

/**
 * A button: Discord's own, through Evi's `Components.Button`, or a styled plain button when Discord's
 * is missing. A "link" button always uses the plain one, which reads as a link.
 */
export function Button({ children, onClick, variant = "secondary", size = "small", disabled = false, busy = false, label, type = "button" }: ButtonProps): ReactElement {
    useMistStyles();
    const Discord = evi.Components?.Button as DiscordButton | undefined;
    if (Discord && variant !== "link") {
        return evi.React.createElement(Discord, {
            color: Discord.Colors?.[COLORS[variant]], size: Discord.Sizes?.[SIZES[size]], type, onClick,
            disabled: disabled || busy, submitting: busy, "aria-busy": busy || undefined, "aria-label": label,
        }, children);
    }
    return evi.React.createElement("button", {
        type, className: "mist-button", "data-variant": variant, "data-size": size, onClick,
        disabled: disabled || busy, "aria-busy": busy || undefined, "aria-label": label,
    }, children);
}

export interface TipProps {
    text: string;
    /** Default Discord's, above */
    position?: "top" | "bottom" | "left" | "right";
    /** One element that can take a `title`, such as a button or a span */
    children: ReactElement<{ title?: string; }>;
}

/** Discord's tooltip on `children`, or a `title` attribute when Discord's is missing */
export function Tip({ text, position, children }: TipProps): ReactElement {
    const Tooltip = evi.Components?.Tooltip as ComponentType<any> | undefined;
    if (Tooltip) return evi.React.createElement(Tooltip, { text, ...position && { position } }, children);
    return evi.React.cloneElement(children, { title: text });
}

/** A panel with Discord's raised background, to group rows */
export function Card({ children }: { children?: ReactNode; }): ReactElement {
    useMistStyles();
    return evi.React.createElement("div", { className: "mist-card" }, children);
}

export interface RowProps {
    title: ReactNode;
    description?: ReactNode;
    /** Buttons or other controls, on the right */
    actions?: ReactNode;
    /** Shown under the row's text, across its width */
    children?: ReactNode;
}

/** A settings row: a title and a description on the left, actions on the right */
export function Row({ title, description, actions, children }: RowProps): ReactElement {
    useMistStyles();
    return evi.React.createElement(evi.React.Fragment, null,
        evi.React.createElement("div", { className: "mist-row" },
            evi.React.createElement("div", { className: "mist-row-text" },
                evi.React.createElement("div", { className: "mist-row-title" }, title),
                description != null && evi.React.createElement("div", { className: "mist-row-description" }, description)),
            actions != null && evi.React.createElement("div", { className: "mist-row-actions" }, actions)),
        children);
}

export type CalloutTone = "info" | "warning" | "danger" | "success";

export interface CalloutProps {
    /** Default "info" */
    tone?: CalloutTone;
    title?: ReactNode;
    children?: ReactNode;
}

/** A coloured note for something the user should know, in Discord's status colours */
export function Callout({ tone = "info", title, children }: CalloutProps): ReactElement {
    useMistStyles();
    return evi.React.createElement("div", { className: "mist-callout", "data-tone": tone, role: "note" },
        title != null && evi.React.createElement("div", { className: "mist-callout-title" }, title),
        children);
}
