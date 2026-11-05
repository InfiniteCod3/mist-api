import { React } from "@evi/api";
import type { ComponentClass, ComponentType, ErrorInfo, ReactNode } from "react";

import { type ErrorLog, logOnce } from "./shared.ts";

/** What shows in place of UI that threw: a node, or a function of the error and a retry */
export type Fallback = ReactNode | ((error: unknown, retry: () => void) => ReactNode);

export interface BoundaryOptions {
    /** Shown instead of the UI after it throws. Defaults to a one-line notice with a Retry button; null shows nothing. */
    fallback?: Fallback;
    /** Names the UI in the log line and the default notice */
    name?: string;
    /** Logs through this plugin's mist (or anything with a `log.error`); the console otherwise */
    mist?: { readonly log: ErrorLog; };
}

export interface BoundaryProps extends BoundaryOptions {
    children?: ReactNode;
}

interface BoundaryState {
    failed: boolean;
    error: unknown;
}

function DefaultFallback({ name, retry }: { name: string | undefined; retry: () => void; }) {
    return React.createElement("span", {
        role: "alert",
        style: { display: "inline-flex", gap: 6, alignItems: "baseline", color: "var(--text-feedback-critical, var(--text-danger, #f23f43))", fontSize: 12 },
    },
    `${name ?? "This"} couldn't be shown.`,
    React.createElement("button", {
        type: "button",
        onClick: retry,
        style: { all: "unset", cursor: "pointer", textDecoration: "underline", color: "var(--text-link, #00a8fc)" },
    }, "Retry"));
}

let BoundaryClass: ComponentClass<BoundaryProps, BoundaryState> | undefined;

/** React is only there once Discord's modules load, and plugins are evaluated before that: made on first render */
function boundaryClass() {
    return BoundaryClass ??= class MistBoundary extends React.Component<BoundaryProps, BoundaryState> {
        override state: BoundaryState = { failed: false, error: undefined };

        static getDerivedStateFromError(error: unknown): BoundaryState {
            return { failed: true, error };
        }

        override componentDidCatch(error: unknown, _info: ErrorInfo) {
            const { name, mist } = this.props;
            logOnce(mist?.log ?? console, `${name ?? "A component"} threw while rendering; showing its fallback`, error);
        }

        retry = () => this.setState({ failed: false, error: undefined });

        override render() {
            if (!this.state.failed) return this.props.children ?? null;
            const { fallback, name } = this.props;
            if (fallback === undefined) return React.createElement(DefaultFallback, { name, retry: this.retry });
            return typeof fallback === "function" ? fallback(this.state.error, this.retry) : fallback;
        }
    };
}

/**
 * Catches errors while its children render, so a plugin's broken UI shows a small fallback instead
 * of taking Discord's surrounding UI down. Each distinct error is logged once.
 */
export function Boundary(props: BoundaryProps) {
    return React.createElement(boundaryClass(), props);
}

/** `Component` inside a Boundary, for handing to Discord or a patch */
export function boundary<P extends object>(Component: ComponentType<P>, options: BoundaryOptions = {}): ComponentType<P> {
    const name = options.name ?? (Component.displayName || Component.name || undefined);
    const Wrapped = (props: P) => React.createElement(Boundary, { ...options, name }, React.createElement(Component, props));
    Wrapped.displayName = `boundary(${name ?? "Component"})`;
    return Wrapped;
}
