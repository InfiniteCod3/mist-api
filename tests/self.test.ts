import { expect, test } from "bun:test";

import { createMist } from "../src/index";
import { fakeContext, mistNative } from "./helpers";

const Mist = () => (globalThis as any).Mist;
const start = (id: string) => fakeContext(mistNative(false), {}, id);
const warns = (run: ReturnType<typeof fakeContext>) => run.printed.filter(p => p.level === "warn").map(p => p.args[0]);

test("a $self name the definition has no function for is a warning, logged once and listed for each run", () => {
    const mist = createMist("t-self-typo");
    const definition = mist.define({
        patches: [
            { find: "a", replace: { match: /x/, with: "$self.injectButton($1)" } },
            { find: "b", replace: [{ match: /y/, with: "($self?.injectButon?.(arguments[0]),$1)" }, { match: /z/, with: "$self?.filter?.($1) ?? $1" }] },
        ],
        injectButton() { },
        filter: (x: unknown) => x,
    });

    const first = start("t-self-typo");
    definition.start!(first.ctx);
    const line = "patches[1] calls $self.injectButon, but the definition has no function injectButon, so Discord's code gets undefined there. Did you mean injectButton?";
    expect(Mist().get("t-self-typo").state().warnings).toEqual([line]);
    expect(warns(first)).toEqual([line]);

    first.dispose();
    const second = start("t-self-typo");
    definition.start!(second.ctx);
    expect(Mist().get("t-self-typo").state().warnings).toEqual([line]);
    expect(warns(second)).toEqual([]);
});

test("each form of $self is checked: a call, an optional call, and a read of a missing member", () => {
    const mist = createMist("t-self-forms");
    const definition = mist.define({
        patches: [{
            find: "a",
            replace: [
                { match: /a/, with: "$self.render(e)" },
                { match: /b/, with: "$self?.wrap ( e )" },
                { match: /c/, with: "$self?.label?.(e)" },
                { match: /d/, with: "$self.enabled&&e" },
                { match: /e/, with: "$self.limit" },
            ],
        }],
        label: "not a function",
        limit: 5,
    });
    const run = start("t-self-forms");
    definition.start!(run.ctx);
    expect(Mist().get("t-self-forms").state().warnings).toEqual([
        "patches[0] calls $self.render, but the definition has no function render, so Discord's code gets undefined there",
        "patches[0] calls $self.wrap, but the definition has no function wrap, so Discord's code gets undefined there",
        "patches[0] calls $self.label, but the definition has no function label, so Discord's code gets undefined there",
        "patches[0] reads $self.enabled, but the definition has no enabled, so Discord's code gets undefined there",
    ]);
});

test("function replacements aren't checked, and a definition whose names all exist has no warnings", () => {
    const mist = createMist("t-self-clean");
    const definition = mist.define({
        patches: [
            { find: "a", replace: { match: /x/, with: () => "$self.whatever()" } },
            { find: "b", replace: { match: /y/, with: "$self.start, $self?.handle?.($1)" } },
        ],
        handle() { },
    });
    const run = start("t-self-clean");
    definition.start!(run.ctx);
    expect(Mist().get("t-self-clean").state().warnings).toEqual([]);
    expect(warns(run)).toEqual([]);
});
