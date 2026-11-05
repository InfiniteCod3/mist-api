import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Connection, evaluate, open } from "../bin/cdp";
import { type Box, inspect, inspectLines } from "../bin/inspect";

/** A Chromium browser to run mist inspect's page code in: $CHROME_PATH, or a usual install */
const browser = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
].find((path): path is string => !!path && existsSync(path));

const PAGE = `<!doctype html>
<style>
    div, p, span { margin: 0; padding: 0 }
    .row { display: flex; justify-content: space-between; gap: 8px; width: 300px }
    .row > .item { flex: 1 1 0px; white-space: nowrap }
    .item, .item::before { overflow: hidden }
    @media (max-width: 1px) { .item { display: none } }
    @media (min-width: 2px) { .item { min-width: 40px } }
    .item { color: red }
</style>
<div class="outer"><div class="row"><span class="item">one</span><span class="item">two</span><span class="item">three</span></div></div>`;

let chrome: ChildProcess | undefined;
let page: Connection;
const profile = mkdtempSync(join(tmpdir(), "mist-inspect-"));

beforeAll(async () => {
    if (!browser) return;
    chrome = spawn(browser, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--window-size=800,600", "about:blank"], { stdio: "ignore" });
    const portFile = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 200 && !existsSync(portFile); i++) await Bun.sleep(50);
    const port = readFileSync(portFile, "utf8").split("\n")[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string; }[];
    page = await open(targets.find(t => t.type === "page")!.webSocketDebuggerUrl);
    await evaluate(page.send, `document.open(); document.write(${JSON.stringify(PAGE)}); document.close(); true`);
}, 30_000);

afterAll(async () => {
    page?.close();
    chrome?.kill();
    if (chrome) await new Promise(resolve => chrome!.once("exit", resolve));
    rmSync(profile, { recursive: true, force: true });
});

const rules = (box: Box) => box.rules.map(r => `${[...r.conditions, r.selector].join(" ")} { ${r.declarations.join("; ")} }`);

test.skipIf(!browser)("mist inspect shows an element, its ancestors, and the CSS rules that set their layout", async () => {
    const { matches, elements } = await inspect(page.send, ".item", 2, false);
    expect(matches).toBe(3);
    expect(elements).toHaveLength(1);
    const [item, row, outer] = elements[0];
    expect([item.tag, item.classes, row.classes, outer.classes]).toEqual(["span", ["item"], ["row"], ["outer"]]);
    expect(item.style).toMatchObject({ flex: "1 1 0px", "white-space": "nowrap", overflow: "hidden" });
    expect(item.style).not.toHaveProperty("margin");
    expect(row.style).toMatchObject({ display: "flex", "justify-content": "space-between", gap: "8px" });
    expect(row.rect.width).toBe(300);
    expect(row.children).toEqual({ count: 3, first: ["span.item", "span.item", "span.item"] });
    expect(rules(item)).toEqual([
        "span (1 of 3 selectors) { margin: 0px; padding: 0px }",
        ".row > .item { flex: 1 1 0px; white-space: nowrap }",
        ".item (1 of 2 selectors) { overflow: hidden }",
        "@media (min-width: 2px) .item { min-width: 40px }",
    ]);
}, 30_000);

test.skipIf(!browser)("--all inspects each match, and --depth 0 only the element", async () => {
    const { elements } = await inspect(page.send, ".item", 0, true);
    expect(elements.map(chain => chain.length)).toEqual([1, 1, 1]);
}, 30_000);

test.skipIf(!browser)("the lines say what matched and where each rule comes from", async () => {
    const lines = inspectLines(await inspect(page.send, ".row", 0, false), ".row");
    expect(lines[0]).toBe("1 element matches .row");
    expect(lines).toContain('  .row { display: flex; justify-content: space-between; gap: 8px; width: 300px }  <style>');
    expect(inspectLines(await inspect(page.send, ".none", 0, false), ".none")).toEqual(["Nothing matches .none"]);
}, 30_000);
