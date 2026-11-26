/**
 * mist react: the React components that render an element, nearest first, with their props masked and
 * Evi's hooks marked. A password or one-time-code input's value is masked too.
 */
import type { Send } from "./cdp.ts";
import { type Limits, type PageGlobal, pageCall } from "./page.ts";

export interface Component {
    name: string;
    /** The fiber's kind: function, class, memo, forwardRef, context, or host for the element itself */
    kind: string;
    props: unknown;
    /** Evi hooked the component's function (it carries Evi's evi.hookOriginal symbol) */
    hooked: boolean;
    /** Plugins with a measured hook named after the component: a guess, since Evi keeps no record of whose hook it is */
    hookedBy: string[];
}
/** `problem` says why the first match has no components to show */
export interface ReactTree { matches: number; components: Component[]; problem?: string; }

interface Fiber { type: unknown; memoizedProps: unknown; return: Fiber | null; }
/** The fields of a React element type that mist reads: memo, forwardRef, context and their names */
interface ElementType { $$typeof?: symbol; type?: unknown; render?: unknown; displayName?: string; _context?: { displayName?: string; }; }
type ReactPage = PageGlobal<{ Evi: { perf: { snapshot(): { plugin: string; sites: { kind: string; name: string; }[]; }[]; }; }; }>;

/** Page side */
function reactPage(snapshot: (value: unknown, limits: Limits) => unknown, selector: string, depth: number, limits: Limits): ReactTree {
    const found = document.querySelectorAll(selector);
    const el = found[0];
    if (!el) return { matches: 0, components: [] };
    const key = Object.keys(el).find(k => k.startsWith("__reactFiber$"));
    if (!key) return { matches: found.length, components: [], problem: "React doesn't render this element: it has no fiber" };

    const hookSites: [string, string][] = [];
    try {
        for (const plugin of (globalThis as ReactPage).Evi.perf.snapshot()) {
            for (const site of plugin.sites) if (site.kind === "hook") hookSites.push([plugin.plugin, site.name]);
        }
    } catch { }

    const MEMO = Symbol.for("react.memo"), FORWARD = Symbol.for("react.forward_ref"), PROVIDER = Symbol.for("react.provider"), CONTEXT = Symbol.for("react.context"), CONSUMER = Symbol.for("react.consumer");
    const isHooked = (fn: unknown) => typeof fn === "function" && Object.getOwnPropertySymbols(fn).some(symbol => symbol.description === "evi.hookOriginal");
    const nameOf = (fn: unknown) => typeof fn === "function" ? (fn as { displayName?: string; }).displayName || fn.name : "";
    const describe = (type: unknown): { name: string; kind: string; fns: unknown[]; } | null => {
        if (typeof type === "function") return { name: nameOf(type) || "Anonymous", kind: type.prototype?.isReactComponent ? "class" : "function", fns: [type] };
        if (!type || typeof type !== "object") return null;
        const element: ElementType = type;
        switch (element.$$typeof) {
            case MEMO: {
                const inner = describe(element.type);
                return { name: element.displayName || inner?.name || "Anonymous", kind: "memo", fns: [element.type, ...inner?.fns ?? []] };
            }
            case FORWARD:
                return { name: element.displayName || nameOf(element.render) || "Anonymous", kind: "forwardRef", fns: [element.render] };
            case PROVIDER:
            case CONTEXT:
                return { name: `${element.displayName || element._context?.displayName || "Context"}.Provider`, kind: "context", fns: [] };
            case CONSUMER:
                return { name: `${element._context?.displayName || "Context"}.Consumer`, kind: "context", fns: [] };
        }
        return null;
    };
    const propsOf = (props: unknown) => {
        if (!props || typeof props !== "object") return props ?? null;
        const { children, ...shown }: Record<string, unknown> = { ...props };
        const autocomplete = Object.keys(shown).find(key => key.toLowerCase() === "autocomplete");
        // A typed password or code is a prop named value, which snapshot's name check doesn't mask
        if (String(shown.type).toLowerCase() === "password" || (autocomplete && /password|one-time-code/i.test(String(shown[autocomplete])))) {
            for (const key of ["value", "defaultValue"]) if (shown[key] !== undefined) shown[key] = "[secret]";
        }
        if (children !== undefined) {
            if (Array.isArray(children)) shown.children = `[${children.length} children]`;
            else if (typeof children === "string") shown.children = children;
            else shown.children = "[1 child]";
        }
        return snapshot(shown, limits);
    };

    const components: Component[] = [];
    let fiber: Fiber | null = (el as Element & { [fiberKey: string]: Fiber; })[key];
    const label = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + Array.from(el.classList).map(name => `.${name}`).join("");
    components.push({ name: label, kind: "host", props: propsOf(fiber.memoizedProps), hooked: false, hookedBy: [] });
    for (fiber = fiber.return; fiber && components.length <= depth; fiber = fiber.return) {
        const described = describe(fiber.type);
        if (!described) continue;
        const hooked = described.fns.some(isHooked);
        const word = new RegExp(`(^|[\\s.(])${described.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[\\s.)])`);
        const hookedBy = hooked && described.name.length > 2 ? [...new Set(hookSites.filter(([, site]) => word.test(site)).map(([plugin]) => plugin))] : [];
        components.push({ name: described.name, kind: described.kind, props: propsOf(fiber.memoizedProps), hooked, hookedBy });
    }
    return { matches: found.length, components };
}

export const readReact = (send: Send, selector: string, depth: number, limits: Limits) =>
    pageCall(send, reactPage, [selector, depth, limits], true);

export function reactLines({ matches, components, problem }: ReactTree, selector: string): string[] {
    if (!matches) return [`Nothing matches ${selector}`];
    const out = [`${matches} ${matches === 1 ? "element matches" : "elements match"} ${selector}${matches > 1 ? ", showing the first" : ""}`];
    if (problem) return [...out, problem];
    components.forEach((component, level) => {
        const indent = "  ".repeat(level);
        const host = component.kind === "host";
        const hook = component.hooked ? `  hooked by Evi${component.hookedBy.length ? ` (maybe ${component.hookedBy.join(", ")})` : ""}` : "";
        const kind = host || component.kind === "function" ? "" : `  ${component.kind}`;
        out.push(`${indent}${host ? component.name : `<${component.name}>`}${kind}${hook}`);
        if (component.props && typeof component.props === "object" && Object.keys(component.props).length) out.push(`${indent}  ${JSON.stringify(component.props)}`);
    });
    return out;
}
