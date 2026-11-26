/** mist inspect: an element's layout and its ancestors', with the CSS rules that set it */
import type { Send } from "./cdp.ts";
import { pageCall } from "./page.ts";

export interface Rule { selector: string; source: string; conditions: string[]; declarations: string[]; }
export interface Box {
    tag: string;
    id: string;
    classes: string[];
    rect: { x: number; y: number; width: number; height: number; };
    /** Computed layout values that differ from the property's initial value */
    style: Record<string, string>;
    children: { count: number; first: string[]; };
    inline: string;
    rules: Rule[];
}
export interface Inspected { matches: number; elements: Box[][]; skippedSheets: number; }

/** Page side. Each match is a list: the element, then each ancestor up to `depth`. */
function inspectPage(selector: string, depth: number, all: boolean): Inspected {
    // Computed values whose initial value says nothing about the layout bug at hand
    const INITIAL: Record<string, string[]> = {
        display: [], position: ["static"],
        "min-width": ["auto", "0px"], "max-width": ["none"], "min-height": ["auto", "0px"], "max-height": ["none"],
        "flex-direction": ["row"], "flex-wrap": ["nowrap"], flex: ["0 1 auto"], order: ["0"],
        "justify-content": ["normal"], "align-items": ["normal"], "align-self": ["auto"], gap: ["normal", "normal normal"],
        "grid-template-columns": ["none"], margin: ["0px"], padding: ["0px"], overflow: ["visible", "visible visible"],
        "white-space": ["normal"], "text-overflow": ["clip"],
        top: ["auto"], right: ["auto"], bottom: ["auto"], left: ["auto"], transform: ["none"],
    };
    const LAYOUT = /^(display|position|top|right|bottom|left|inset|box-sizing|(min-|max-)?(width|height)|flex|justify-|align-|place-|gap|row-gap|column-gap|grid|order|margin|padding|overflow|white-space|text-overflow|contain|transform)/;

    const rules: { rule: CSSStyleRule; source: string; conditions: string[]; declarations: string[]; }[] = [];
    let skippedSheets = 0;
    const collect = (list: CSSRuleList, source: string, conditions: string[]) => {
        for (const rule of Array.from(list)) {
            if (rule instanceof CSSStyleRule) {
                const declarations = rule.style.cssText.split(/;(?![^(]*\))/).map(declaration => declaration.trim()).filter(declaration => LAYOUT.test(declaration));
                if (declarations.length) rules.push({ rule, source, conditions, declarations });
            } else if (rule instanceof CSSMediaRule) {
                if (matchMedia(rule.media.mediaText).matches) collect(rule.cssRules, source, [...conditions, `@media ${rule.media.mediaText}`]);
            } else if (rule instanceof CSSGroupingRule) {
                const prelude = rule.cssText.slice(0, rule.cssText.indexOf("{")).trim();
                collect(rule.cssRules, source, prelude ? [...conditions, prelude] : conditions);
            }
        }
    };
    for (const sheet of Array.from(document.styleSheets)) {
        const owner = sheet.ownerNode as Element | null;
        let source = "<style>";
        if (sheet.href) source = sheet.href.replace(/[?#].*$/, "").split("/").pop()!;
        else if (owner?.id) source = `<style id="${owner.id}">`;
        try { collect(sheet.cssRules, source, []); } catch { skippedSheets++; }
    }

    const label = (el: Element) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + Array.from(el.classList).map(name => `.${name}`).join("");
    const box = (el: Element): Box => {
        const computed = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const [property, initial] of Object.entries(INITIAL)) {
            const value = computed.getPropertyValue(property);
            if (value && !initial.includes(value)) style[property] = value;
        }
        const rect = el.getBoundingClientRect();
        const matches = (selector: string) => {
            try { return el.matches(selector); } catch { return false; }
        };
        // A list such as a reset's "a, abbr, ..., div" shows as the selectors in it that match; one with ::before can't be matched whole
        const matching = rules.flatMap(({ rule, source, conditions, declarations }) => {
            const parts = rule.selectorText.split(/,(?![^(]*\))(?![^[]*\])/).map(part => part.trim());
            if (parts.length === 1) return matches(parts[0]) ? [{ selector: parts[0], source, conditions, declarations }] : [];
            const hit = parts.filter(matches);
            return hit.length ? [{ selector: `${hit.join(", ")}${hit.length < parts.length ? ` (${hit.length} of ${parts.length} selectors)` : ""}`, source, conditions, declarations }] : [];
        });
        return {
            tag: el.tagName.toLowerCase(),
            id: el.id,
            classes: Array.from(el.classList),
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 },
            style,
            children: { count: el.children.length, first: Array.from(el.children).slice(0, 5).map(label) },
            inline: el.getAttribute("style") ?? "",
            rules: matching,
        };
    };

    const found = Array.from(document.querySelectorAll(selector));
    const elements = (all ? found : found.slice(0, 1)).map(el => {
        const chain: Box[] = [];
        for (let at: Element | null = el; at && chain.length <= depth; at = at.parentElement) chain.push(box(at));
        return chain;
    });
    return { matches: found.length, elements, skippedSheets };
}

export const inspect = (send: Send, selector: string, depth: number, all: boolean) =>
    pageCall(send, inspectPage, [selector, depth, all]);

const name = (box: Box) => box.tag + (box.id ? `#${box.id}` : "") + box.classes.map(className => `.${className}`).join("");

function childrenLine({ count, first }: Box["children"]): string {
    if (!first.length) return `  children: ${count}`;
    return `  children: ${count} (${first.join(", ")}${count > first.length ? ", …" : ""})`;
}

function boxLines(box: Box, level: number): string[] {
    const { x, y, width, height } = box.rect;
    const out = ["", `${level ? `parent ${level}` : "element"}  ${name(box)}  ${width}x${height} at ${x},${y}`];
    const style = Object.entries(box.style).map(([property, value]) => `${property}: ${value}`);
    if (style.length) out.push(`  ${style.join("; ")}`);
    out.push(childrenLine(box.children));
    if (box.inline) out.push(`  style="${box.inline}"`);
    for (const rule of box.rules) out.push(`  ${[...rule.conditions, rule.selector].join(" ")} { ${rule.declarations.join("; ")} }  ${rule.source}`);
    return out;
}

export function inspectLines({ matches, elements, skippedSheets }: Inspected, selector: string): string[] {
    if (!matches) return [`Nothing matches ${selector}`];
    const out = [`${matches} ${matches === 1 ? "element matches" : "elements match"} ${selector}${elements.length < matches ? ", showing the first (--all shows each)" : ""}`];
    if (skippedSheets) out.push(`${skippedSheets} stylesheets from another origin couldn't be read: their rules aren't listed`);
    elements.forEach((chain, i) => {
        if (elements.length > 1) out.push("", `match ${i + 1}`);
        chain.forEach((box, level) => out.push(...boxLines(box, level)));
    });
    return out;
}
