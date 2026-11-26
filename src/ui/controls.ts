/** Settings-panel pieces that look like Discord's, with a plain fallback when Discord's component is missing. */
// A namespace import, read at render: Discord's React and components exist only once its modules load,
// and a test's mock of @evi/api may have no Components, which a named import would fail to link
import * as evi from "@evi/api";
import type { ChangeEvent, ComponentType, FocusEvent, KeyboardEvent, MouseEvent, ReactElement, ReactNode } from "react";

import { useMistStyles } from "./styles.ts";

/** React's createElement, looked up on each call: Discord's React isn't there when this module loads */
const h: typeof evi.React.createElement = (...args: unknown[]) => Reflect.apply(evi.React.createElement, evi.React, args);

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

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
 * A button: Discord's, through Evi's `Components.Button`, or a styled plain button when Discord's
 * is missing. A "link" button always uses the plain one, which reads as a link.
 */
export function Button({ children, onClick, variant = "secondary", size = "small", disabled = false, busy = false, label, type = "button" }: ButtonProps): ReactElement {
    useMistStyles();
    const Discord = evi.Components?.Button as DiscordButton | undefined;
    if (Discord && variant !== "link") {
        return h(Discord, {
            color: Discord.Colors?.[COLORS[variant]], size: Discord.Sizes?.[SIZES[size]], type, onClick,
            disabled: disabled || busy, submitting: busy, "aria-busy": busy || undefined, "aria-label": label,
        }, children);
    }
    return h("button", {
        type, className: "mist-button", "data-variant": variant, "data-size": size, onClick,
        disabled: disabled || busy, "aria-busy": busy || undefined, "aria-label": label,
    }, children);
}

export interface SwitchProps {
    checked: boolean;
    onChange(checked: boolean): void;
    /** Shown on the left, with the switch on the right, and names the switch */
    label?: ReactNode;
    /** Shown under the label */
    description?: ReactNode;
    disabled?: boolean;
    /** Added to the outermost element */
    className?: string;
    /** The switch's id. Defaults to a generated one. */
    id?: string;
    /** The accessible name of a switch without a label */
    "aria-label"?: string;
}

/**
 * A toggle: Discord's switch, through Evi's `Components.Switch`, or a styled plain one when Discord's
 * is missing. With a label or description it's a settings row, the text on the left.
 */
export function Switch({ checked, onChange, label, description, disabled = false, className, id, "aria-label": ariaLabel }: SwitchProps): ReactElement {
    useMistStyles();
    const generated = evi.React.useId();
    const switchId = id ?? `mist-switch${generated}`;
    const labelId = `${switchId}-label`;
    const descriptionId = description != null ? `${switchId}-description` : undefined;
    const bare = label == null && description == null;
    const Discord = evi.Components?.Switch;

    let control: ReactElement;
    if (Discord && (label != null || ariaLabel)) {
        // Discord's switch takes its name only from labelledBy. Its real checkbox is absolutely placed,
        // and the anchor is its positioned parent: without one, focusing it scrolls the page away.
        control = h("span", { className: classes("mist-switch-anchor", bare && className) },
            label == null && h("span", { id: labelId, className: "mist-sr-only" }, ariaLabel),
            h(Discord, { checked, onChange, disabled, id: switchId, labelledBy: labelId, describedBy: descriptionId }));
    } else {
        control = h("button", {
            type: "button", role: "switch", id: switchId, className: classes("mist-switch", bare && className),
            "aria-checked": checked, "aria-labelledby": label != null ? labelId : undefined, "aria-label": ariaLabel,
            "aria-describedby": descriptionId, disabled, onClick: () => onChange(!checked),
        });
    }
    if (bare) return control;
    return h("div", { className: classes("mist-switch-row", className) },
        h("div", { className: "mist-switch-text" },
            label != null && h("label", { id: labelId, htmlFor: switchId, className: "mist-switch-label" }, label),
            description != null && h("div", { id: descriptionId, className: "mist-switch-description" }, description)),
        control);
}

export interface TextInputProps {
    value: string;
    onChange(value: string): void;
    /** Shown above the input, and names it */
    label?: ReactNode;
    /** Shown under the label, and describes the input to screen readers */
    description?: ReactNode;
    placeholder?: string;
    disabled?: boolean;
    readOnly?: boolean;
    maxLength?: number;
    /** Default "text" */
    type?: "text" | "password" | "search" | "url" | "number";
    /** Marks the value as wrong: a red border, and aria-invalid for screen readers */
    invalid?: boolean;
    /** Added to the input */
    className?: string;
    /** The input's id. With a label or description, defaults to a generated one. */
    id?: string;
    name?: string;
    /** The accessible name of an input without a label */
    "aria-label"?: string;
    onKeyDown?(event: KeyboardEvent<HTMLInputElement>): void;
    onBlur?(event: FocusEvent<HTMLInputElement>): void;
    onFocus?(event: FocusEvent<HTMLInputElement>): void;
}

/**
 * A one-line text box in Discord's input colours. It's always a plain input, never Discord's: Evi's
 * `Components.TextField` doesn't promise to pass on readOnly, name or the key and focus handlers,
 * and an Enter handler that never runs is worse than a box a shade off Discord's. With a label or
 * description it's a settings field, the text above the input.
 */
export function TextInput({ value, onChange, label, description, type = "text", invalid = false, className, id, ...rest }: TextInputProps): ReactElement {
    useMistStyles();
    const generated = evi.React.useId();
    const bare = label == null && description == null;
    const inputId = id ?? (bare ? undefined : `mist-input${generated}`);
    const descriptionId = description != null ? `${inputId}-description` : undefined;
    const input = h("input", {
        ...rest, id: inputId, type, value, className: classes("mist-input", className),
        "aria-invalid": invalid || undefined, "aria-describedby": descriptionId,
        onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.currentTarget.value),
    });
    if (bare) return input;
    return h("div", { className: "mist-field" },
        label != null && h("label", { htmlFor: inputId, className: "mist-field-label" }, label),
        description != null && h("div", { id: descriptionId, className: "mist-field-description" }, description),
        input);
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
    if (Tooltip) return h(Tooltip, { text, ...position && { position } }, children);
    return evi.React.cloneElement(children, { title: text });
}

/** A panel with Discord's raised background, to group rows */
export function Card({ children }: { children?: ReactNode; }): ReactElement {
    useMistStyles();
    return h("div", { className: "mist-card" }, children);
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
    return h(evi.React.Fragment, null,
        h("div", { className: "mist-row" },
            h("div", { className: "mist-row-text" },
                h("div", { className: "mist-row-title" }, title),
                description != null && h("div", { className: "mist-row-description" }, description)),
            actions != null && h("div", { className: "mist-row-actions" }, actions)),
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
    return h("div", { className: "mist-callout", "data-tone": tone, role: "note" },
        title != null && h("div", { className: "mist-callout-title" }, title),
        children);
}
