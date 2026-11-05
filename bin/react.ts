/**
 * mist react: the React components that render an element, nearest first, with their props masked and
 * Evi's hooks marked. A password or one-time-code input's value is masked too.
 */
import { evaluate, type Send } from "./cdp.ts";
import { type Limits, pageExpression } from "./page.ts";

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
export interface ReactTree { matches: number; components: Component[]; error?: string; }

/** Page side */
function reactPage(snapshot: (value: unknown, limits: Limits) => unknown, selector: string, depth: number, limits: Limits): ReactTree {
    const found = document.querySelectorAll(selector);
    const el = found[0];
    if (!el) return { matches: 0, components: [] };
    const key = Object.keys(el).find(k => k.startsWith("__reactFiber$"));
    if (!key) return { matches: found.length, components: [], error: "React doesn't render this element: it has no fiber" };

    const hookSites: [string, string][] = [];
    try {
        for (const p of (globalThis as any).Evi.perf.snapshot()) for (const s of p.sites) if (s.kind === "hook") hookSites.push([p.plugin, s.name]);
    } catch { }

    const MEMO = Symbol.for("react.memo"), FORWARD = Symbol.for("react.forward_ref"), PROVIDER = Symbol.for("react.provider"), CONTEXT = Symbol.for("react.context"), CONSUMER = Symbol.for("react.consumer");
    const isHooked = (fn: unknown) => typeof fn === "function" && Object.getOwnPropertySymbols(fn).some(s => s.description === "evi.hookOriginal");
    const nameOf = (fn: any) => (typeof fn === "function" && (fn.displayName || fn.name)) || "";
    const describe = (type: any): { name: string; kind: string; fns: unknown[]; } | null => {
        if (typeof type === "function") return { name: nameOf(type) || "Anonymous", kind: type.prototype?.isReactComponent ? "class" : "function", fns: [type] };
        if (!type || typeof type !== "object") return null;
        if (type.$$typeof === MEMO) {
            const inner = describe(type.type);
            return { name: type.displayName || inner?.name || "Anonymous", kind: "memo", fns: [type.type, ...inner?.fns ?? []] };
        }
        if (type.$$typeof === FORWARD) return { name: type.displayName || nameOf(type.render) || "Anonymous", kind: "forwardRef", fns: [type.render] };
        if (type.$$typeof === PROVIDER || type.$$typeof === CONTEXT) return { name: `${type.displayName || type._context?.displayName || "Context"}.Provider`, kind: "context", fns: [] };
        if (type.$$typeof === CONSUMER) return { name: `${type._context?.displayName || "Context"}.Consumer`, kind: "context", fns: [] };
        return null;
    };
    const propsOf = (props: any) => {
        if (!props || typeof props !== "object") return props ?? null;
        const { children, ...rest } = props;
        const shown: Record<string, unknown> = rest;
        const autocomplete = Object.keys(shown).find(k => k.toLowerCase() === "autocomplete");
        // A typed password or code is a prop named value, which snapshot's name check doesn't mask
        if (String(shown.type).toLowerCase() === "password" || (autocomplete && /password|one-time-code/i.test(String(shown[autocomplete])))) {
            for (const k of ["value", "defaultValue"]) if (shown[k] !== undefined) shown[k] = "[secret]";
        }
        if (children !== undefined) shown.children = Array.isArray(children) ? `[${children.length} children]` : typeof children === "string" ? children : "[1 child]";
        return snapshot(shown, limits);
    };

    const components: Component[] = [];
    let fiber = (el as any)[key];
    components.push({ name: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + Array.from(el.classList).map(c => `.${c}`).join(""), kind: "host", props: propsOf(fiber.memoizedProps), hooked: false, hookedBy: [] });
    for (fiber = fiber.return; fiber && components.length <= depth; fiber = fiber.return) {
        const d = describe(fiber.type);
        if (!d) continue;
        const hooked = d.fns.some(isHooked);
        const word = new RegExp(`(^|[\\s.(])${d.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[\\s.)])`);
        const hookedBy = hooked && d.name.length > 2 ? [...new Set(hookSites.filter(([, site]) => word.test(site)).map(([plugin]) => plugin))] : [];
        components.push({ name: d.name, kind: d.kind, props: propsOf(fiber.memoizedProps), hooked, hookedBy });
    }
    return { matches: found.length, components };
}

export const readReact = (send: Send, selector: string, depth: number, limits: Limits) =>
    evaluate<ReactTree>(send, pageExpression(reactPage, [selector, depth, limits], true));

export function reactLines({ matches, components, error }: ReactTree, selector: string): string[] {
    if (!matches) return [`Nothing matches ${selector}`];
    const out = [`${matches} ${matches === 1 ? "element matches" : "elements match"} ${selector}${matches > 1 ? ", showing the first" : ""}`];
    if (error) return [...out, error];
    components.forEach((c, level) => {
        const hook = c.hooked ? `  hooked by Evi${c.hookedBy.length ? ` (maybe ${c.hookedBy.join(", ")})` : ""}` : "";
        out.push(`${"  ".repeat(level)}${c.kind === "host" ? c.name : `<${c.name}>`}${c.kind === "host" || c.kind === "function" ? "" : `  ${c.kind}`}${hook}`);
        if (c.props && typeof c.props === "object" && Object.keys(c.props).length) out.push(`${"  ".repeat(level)}  ${JSON.stringify(c.props)}`);
    });
    return out;
}
