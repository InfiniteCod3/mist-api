/**
 * The one stylesheet of mist's settings pieces. Copies of mist-api in different plugins share it
 * through a versioned Symbol.for key. Change the version when the CSS changes: two copies with
 * different CSS then add separate stylesheets.
 */
import { React } from "@evi/api";

const KEY = Symbol.for("mist-api.ui/styles@2");

// Discord's CSS variables, with the older names and plain colours after them for builds that lack them
const CSS = `
.mist-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; box-sizing: border-box; min-inline-size: 60px; padding: 2px 16px; border: 0; border-radius: var(--radius-sm, 8px); font: inherit; font-size: 14px; font-weight: 500; line-height: 16px; cursor: pointer; color: var(--text-default, var(--text-normal, #dbdee1)); background: var(--background-mod-normal, var(--button-secondary-background, #4e5058)); }
.mist-button[data-size="small"] { min-block-size: 32px; }
.mist-button[data-size="medium"] { min-block-size: 38px; }
.mist-button[data-size="large"] { min-block-size: 44px; font-size: 16px; }
.mist-button[data-variant="primary"] { color: var(--white, #fff); background: var(--control-brand-foreground, var(--brand-500, #5865f2)); }
.mist-button[data-variant="danger"] { color: var(--white, #fff); background: var(--status-danger, var(--button-danger-background, #da373c)); }
.mist-button[data-variant="link"] { min-inline-size: 0; min-block-size: 0; padding: 0; background: none; color: var(--text-link, #00a8fc); }
.mist-button[data-variant="link"]:hover:not(:disabled) { text-decoration: underline; }
.mist-button:hover:not(:disabled):not([data-variant="link"]) { filter: brightness(1.1); }
.mist-button:disabled { opacity: 0.5; cursor: not-allowed; }
.mist-button[aria-busy="true"] { cursor: progress; }
.mist-button:focus-visible { outline: 2px solid var(--focus-primary, #00a8fc); outline-offset: 2px; }
.mist-card { box-sizing: border-box; padding: 16px; border: 1px solid var(--border-subtle, var(--background-modifier-accent, rgb(255 255 255 / 0.08))); border-radius: var(--radius-md, 8px); background: var(--background-base-lower, var(--background-secondary, #2b2d31)); color: var(--text-default, var(--text-normal, #dbdee1)); }
.mist-card + .mist-card { margin-block-start: 8px; }
.mist-row { display: flex; align-items: center; gap: 16px; padding-block: 8px; }
.mist-row-text { flex: 1; min-inline-size: 0; }
.mist-row-title { font-size: 16px; font-weight: 500; line-height: 20px; color: var(--text-strong, var(--header-primary, #f2f3f5)); }
.mist-row-description { margin-block-start: 4px; font-size: 14px; line-height: 18px; color: var(--text-muted, #949ba4); }
.mist-row-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; flex-shrink: 0; }
.mist-callout { box-sizing: border-box; margin-block: 8px; padding: 8px 12px; border: 1px solid var(--mist-tone); border-radius: var(--radius-sm, 8px); background: color-mix(in srgb, var(--mist-tone) 12%, transparent); color: var(--text-default, var(--text-normal, #dbdee1)); font-size: 14px; line-height: 18px; }
.mist-callout[data-tone="info"] { --mist-tone: var(--text-link, #00a8fc); }
.mist-callout[data-tone="warning"] { --mist-tone: var(--status-warning, #f0b232); }
.mist-callout[data-tone="danger"] { --mist-tone: var(--status-danger, #f23f43); }
.mist-callout[data-tone="success"] { --mist-tone: var(--status-positive, var(--status-online, #23a55a)); }
.mist-callout-title { font-weight: 600; margin-block-end: 2px; }
.mist-switch-row { display: flex; align-items: center; gap: 16px; padding-block: 8px; }
.mist-switch-text { flex: 1; min-inline-size: 0; }
.mist-switch-label, .mist-field-label { display: block; font-size: 16px; font-weight: 500; line-height: 20px; color: var(--text-strong, var(--header-primary, #f2f3f5)); cursor: pointer; }
.mist-switch-description, .mist-field-description { margin-block-start: 4px; font-size: 14px; line-height: 18px; color: var(--text-muted, #949ba4); }
.mist-field { padding-block: 8px; }
.mist-field > .mist-input { margin-block-start: 8px; }
.mist-switch-anchor { position: relative; display: inline-flex; flex-shrink: 0; }
.mist-switch { position: relative; flex-shrink: 0; box-sizing: border-box; inline-size: 40px; block-size: 24px; padding: 0; border: 0; border-radius: 12px; cursor: pointer; background: var(--background-mod-strong, var(--interactive-muted, #80848e)); transition: background-color 0.15s ease; }
.mist-switch::after { content: ""; position: absolute; inset-block-start: 3px; inset-inline-start: 3px; inline-size: 18px; block-size: 18px; border-radius: 50%; background: var(--white, #fff); transition: inset-inline-start 0.15s ease; }
.mist-switch[aria-checked="true"] { background: var(--control-brand-foreground, var(--brand-500, #5865f2)); }
.mist-switch[aria-checked="true"]::after { inset-inline-start: 19px; }
.mist-switch:disabled { opacity: 0.5; cursor: not-allowed; }
.mist-switch:focus-visible { outline: 2px solid var(--focus-primary, #00a8fc); outline-offset: 2px; }
.mist-input { box-sizing: border-box; inline-size: 100%; min-block-size: 40px; padding: 8px 12px; border: 1px solid var(--input-border, var(--border-subtle, rgb(255 255 255 / 0.08))); border-radius: var(--radius-sm, 8px); background: var(--input-background, var(--background-tertiary, #1e1f22)); color: var(--text-default, var(--text-normal, #dbdee1)); font: inherit; font-size: 16px; line-height: 20px; outline: none; }
.mist-input::placeholder { color: var(--input-placeholder-text, var(--text-muted, #949ba4)); }
.mist-input:focus { border-color: var(--focus-primary, #00a8fc); }
.mist-input[aria-invalid="true"] { border-color: var(--text-feedback-critical, var(--text-danger, #f23f43)); }
.mist-input:disabled { opacity: 0.5; cursor: not-allowed; }
.mist-sr-only { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .mist-switch, .mist-switch::after { transition: none; } }
`;

interface Shared {
    users: number;
    element: HTMLStyleElement | null;
}

const sheet = (): Shared => (globalThis as Record<symbol, Shared | undefined>)[KEY] ??= { users: 0, element: null };

/** Adds the stylesheet to the page while at least one component that uses it is mounted */
export function useMistStyles() {
    React.useInsertionEffect(() => {
        if (typeof document === "undefined") return;
        const state = sheet();
        if (state.users++ === 0) {
            const element = document.createElement("style");
            element.dataset.mist = "ui";
            element.textContent = CSS;
            document.head.append(element);
            state.element = element;
        }
        return () => {
            if (--state.users > 0) return;
            state.element?.remove();
            state.element = null;
        };
    }, []);
}
