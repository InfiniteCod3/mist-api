// Run by cli-extras.test.ts under Node: mist errors, perf, dev, module, react and leaks against a page with Evi's globals, over node:inspector
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";

import type { Listen, Send } from "../../bin/cdp.ts";
import { type DevOutcome, watchDev } from "../../bin/dev.ts";
import { type ErrorRecord, watchErrors } from "../../bin/errors.ts";
import { checkLeakTarget, findLeaks } from "../../bin/leaks.ts";
import { readModule } from "../../bin/module.ts";
import { DISPLAY } from "../../bin/page.ts";
import { readPerf } from "../../bin/perf.ts";
import { readReact } from "../../bin/react.ts";

const session = new Session();
session.connect();
const send: Send = (method, params) => session.post(method as any, params as any);
/** Real inspector events, plus `emit` for the ones Node's inspector doesn't send (exceptions it handles, Log) */
const handlers = new Map<string, Set<(params: any) => void>>();
const listen: Listen = (method, handler) => {
    const fn = (message: { params: unknown; }) => handler(message.params);
    session.on(method as any, fn);
    (handlers.get(method) ?? handlers.set(method, new Set()).get(method)!).add(handler);
    return () => {
        session.off(method as any, fn);
        handlers.get(method)?.delete(handler);
    };
};
const emit = (method: string, params: unknown) => handlers.get(method)?.forEach(h => h(params));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const failure = (promise: Promise<unknown>) => promise.then(() => null, (err: Error) => err.message);
const g = globalThis as any;

const scenarios: Record<string, () => Promise<unknown>> = {
    async errors() {
        g.Evi = {
            plugins: { getSnapshot: () => [{ manifest: { id: "demo-plugin", name: "Demo Plugin" } }] },
            diagnosePatches: () => [{ plugin: "patcher", index: 0, modules: ["77"] }],
        };
        // A plugin as Evi evaluates it (manager.ts evaluate), from the bundle the test built with an inline map
        const code = readFileSync(process.argv[3], "utf8");
        const outer = new Function("fetch", `return function (module, exports, require) {${code}\n};\n//# sourceURL=evi://plugins/mapped-plugin.js`);
        const module = { exports: {} as any };
        outer(null)(module, module.exports, () => ({}));

        console.error("%c Evi %c Demo Plugin ", "color:red", "color:blue", "Flux handler for MESSAGE_CREATE threw", { token: "secret-1", n: 1 });
        console.error("%c Evi %c Hooks ", "a", "b", "after hook of other-plugin on render threw", new Error("hook failed"));
        console.warn("not an error");
        try { module.exports.boom(); } catch (err) { console.error(err); }

        const records: ErrorRecord[] = [];
        let replayedAt = -1;
        let polls = 0;
        await watchErrors(send, listen, {
            follow: true,
            limits: DISPLAY,
            settleMs: 50,
            pollMs: 20,
            stopped: () => polls++ > 5,
            onReplayed: () => {
                replayedAt = records.length;
                emit("Runtime.exceptionThrown", { timestamp: 1000, exceptionDetails: { text: "Uncaught", exception: { type: "object", subtype: "error", description: "TypeError: x is undefined\n    at render (evi://modules/77.js:1:50)" } } });
                emit("Log.entryAdded", { entry: { source: "network", level: "error", text: "Failed to load resource", url: "https://example.com/a", timestamp: 2000 } });
                emit("Log.entryAdded", { entry: { source: "network", level: "warning", text: "ignored", timestamp: 2001 } });
                console.error("%c Evi %c Webpack ", "a", "b", "Module 12 threw. It was patched by: alpha, beta", new Error("bad module"));
            },
        }, r => records.push(r));
        return { records, replayedAt, listening: [...handlers.values()].reduce((n, s) => n + s.size, 0) };
    },

    async perf() {
        g.Evi = {
            stats: { modules: 10, patchedModules: 2, patchMs: 1.5, listenerMs: 0.5, callbackMs: 0 },
            perf: {
                snapshot: () => [{
                    plugin: "alpha", calls: 12, ms: 3, max: 1, recent: { calls: 2, ms: 0.5, max: 0.3 },
                    sites: [{ kind: "patch", name: "$self.used", calls: 12, ms: 3, max: 1, recent: { calls: 2, ms: 0.5, max: 0.3 } }],
                }],
            },
            diagnosePatches: () => [
                { plugin: "alpha", index: 0, state: "applied", modules: ["1"], patch: { find: "a", replace: { match: "x", with: "$self.used()" } } },
                { plugin: "alpha", index: 1, state: "applied", modules: ["2"], patch: { find: "b", replace: [{ match: "y", with: "$self?.unused?.()" }, { match: "z", with: "$self.alsoUnused" }] } },
                { plugin: "alpha", index: 2, state: "pending", modules: [], patch: { find: "c", replace: { match: "y", with: "$self.waiting()" } } },
                { plugin: "beta", index: 0, state: "applied", modules: ["3"], patch: { find: "d", replace: { match: "y", with: () => "$self.hidden()" } } },
                { plugin: "alpha", index: 3, state: "partial", modules: ["5"], patch: { find: "f", replace: { match: "y", with: "$self.used() || $self.neverButAnotherRan()" } } },
                { plugin: "beta", index: 1, state: "applied", modules: ["4"], patch: { find: "e", replace: { match: "y", with: "plain" } } },
            ],
        };
        return await readPerf(send);
    },

    async dev() {
        const listeners = new Set<() => void>();
        const other = { manifest: { id: "other", name: "Other", version: "1.0.0" }, source: "dev", running: true };
        let me: any = { manifest: { id: "demo", name: "Demo", version: "1.0.0" }, source: "dev", running: true, needsReload: false };
        g.Evi = {
            plugins: {
                get: (id: string) => id === "demo" ? me : id === "other" ? other : undefined,
                getSnapshot: () => [me, other],
                subscribe: (fn: () => void) => {
                    listeners.add(fn);
                    return () => listeners.delete(fn);
                },
            },
        };
        const notify = () => listeners.forEach(fn => fn());
        const outcomes: DevOutcome[] = [];
        let polls = 0;
        const steps: [number, () => void][] = [
            // A hot reload: a new manifest, then the async start ends and Evi emits again
            [2, () => { me = { ...me, manifest: { ...me.manifest, version: "1.1.0" } }; notify(); }],
            [3, () => notify()],
            // New code that doesn't evaluate: Evi stops it and keeps the old manifest
            [12, () => { me = { ...me, running: false, error: "SyntaxError: Unexpected token" }; notify(); }],
            // Discord's language changed: every plugin with locales gets a new manifest object
            [22, () => { me = { ...me, manifest: { ...me.manifest } }; other.manifest = { ...other.manifest }; notify(); }],
            // A reload whose start throws, and whose patch can't apply live
            [32, () => { me = { ...me, manifest: { ...me.manifest, version: "1.2.0" }, running: true, error: undefined }; notify(); }],
            [33, () => { me = { ...me, running: false, error: "TypeError: boom", needsReload: true, reloadReason: "patch 0 changed" }; notify(); }],
        ];
        await watchDev(send, "demo", {
            pollMs: 10,
            settleMs: 40,
            stopped: () => {
                polls++;
                for (const [at, step] of steps) if (at === polls) step();
                return polls > 45;
            },
            patches: async () => ({ health: { applied: 2 }, problems: [] }),
        }, o => outcomes.push(o));
        return {
            outcomes: outcomes.map(o => ({ reloaded: o.reloaded, version: o.state.version, running: o.state.running, error: o.state.error, needsReload: o.state.needsReload, patches: o.patches })),
            listeners: listeners.size,
            missing: await failure(watchDev(send, "nope", { patches: async () => null }, () => { })),
        };
    },

    async module() {
        const original = function (e: any, t: any) { const unique_marker = 1; let x = e.foo(1); return x + t.bar + unique_marker; };
        const source = String(original);
        const patched = source.replace("e.foo(1)", `Evi.$("alpha").wrap(e.foo(1))`).replace("t.bar", "t.baz");
        // Kept alive like a module's exports keep Evi's compiled copy alive
        g.compiled = (0, eval)(`0,${patched}\n//# sourceURL=evi://modules/77.js`);
        g.Evi = {
            wreq: { m: { 77: original, 88: function other() { return "function"; } }, c: { 77: { loaded: true } } },
            diagnosePatches: () => [
                { plugin: "alpha", index: 0, modules: ["77"], patch: { find: "unique_marker", replace: { match: "e.foo(1)", with: "$self.wrap(e.foo(1))" } } },
                { plugin: "beta", index: 3, modules: ["77"], patch: { find: "unique_marker", replace: { match: /\i\.bar/, with: "t.baz" } } },
                { plugin: "gamma", index: 0, modules: ["99"], patch: { find: "x", replace: { match: "x", with: "y" } } },
            ],
        };
        const byId = await readModule(send, listen, "77");
        const byText = await readModule(send, listen, "unique_marker");
        return {
            id: byId.id, loaded: byId.loaded, patchedBy: byId.patchedBy, patchedSame: byId.patched === patched,
            hunks: byId.hunks?.map(h => ({ removed: h.removed, added: h.added, plugins: h.plugins, certain: h.certain })),
            byText: byText.id,
            unpatched: (await readModule(send, listen, "88")).patched,
            many: await failure(readModule(send, listen, "function")),
            none: await failure(readModule(send, listen, "no such text anywhere")),
        };
    },

    async react() {
        const hooked = Object.assign(function UserCard() { }, { [Symbol("evi.hookOriginal")]: function UserCard() { } });
        const row = { $$typeof: Symbol.for("react.memo"), type: function Row() { } };
        const fibers = { type: "span", memoizedProps: { className: "name", children: "hi" }, return: {
            type: hooked, memoizedProps: { user: { name: "a", token: "t-1" }, children: ["x", "y"] }, return: {
                type: "div", memoizedProps: {}, return: { type: row, memoizedProps: { id: 3 }, return: null },
            },
        } };
        const el = { tagName: "SPAN", id: "", classList: ["name"], __reactFiber$abc: fibers };
        g.document = { querySelectorAll: (selector: string) => selector === ".name" ? [el, el] : [] };
        g.Evi = { perf: { snapshot: () => [{ plugin: "hooker", sites: [{ kind: "hook", name: "after UserCard" }] }, { plugin: "bystander", sites: [{ kind: "hook", name: "after UserCardList" }] }] } };
        return { tree: await readReact(send, ".name", 10, { ...DISPLAY, depth: 2 }), none: await readReact(send, ".nothing", 10, DISPLAY) };
    },

    async leaks() {
        const subs: Record<string, Set<unknown>> = {};
        const styles: object[] = [];
        g.document = { getElementsByTagName: () => [1, 2, 3], querySelectorAll: () => styles, adoptedStyleSheets: [] };
        const plugins: Record<string, { source: string; running: boolean; leaky: boolean; handler?: () => void; }> = {
            leaky: { source: "dev", running: true, leaky: true },
            clean: { source: "dev", running: true, leaky: false },
            installed: { source: "store", running: true, leaky: false },
            off: { source: "dev", running: false, leaky: false },
        };
        let switches = 0;
        g.Evi = {
            api: { Dispatcher: { _subscriptions: subs, _interceptors: [] } },
            plugins: {
                get: (id: string) => plugins[id] && { source: plugins[id].source, running: plugins[id].running },
                async setEnabled(id: string, on: boolean) {
                    switches++;
                    const p = plugins[id];
                    if (on) {
                        p.handler = () => { };
                        (subs.MESSAGE_CREATE ??= new Set()).add(p.handler);
                        if (p.leaky) styles.push({});
                    } else if (!p.leaky) subs.MESSAGE_CREATE?.delete(p.handler);
                    p.running = on;
                },
            },
        };
        const leaky = await findLeaks(send, "leaky", { cycles: 3, settleMs: 0 });
        const leakySwitches = switches;
        const clean = await findLeaks(send, "clean", { cycles: 3, settleMs: 0 });
        switches = 0;
        return {
            leaky: leaky.growth, leakySwitches, leakyRunning: plugins.leaky.running,
            clean: clean.growth, cleanRunning: plugins.clean.running,
            installed: await failure(findLeaks(send, "installed", { cycles: 1, settleMs: 0 })),
            off: await failure(checkLeakTarget(send, "off")),
            refusedSwitches: switches,
        };
    },
};

console.log(JSON.stringify(await scenarios[process.argv[2]]()));
session.disconnect();
