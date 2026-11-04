import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "mist-cdp-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const built = join(import.meta.dir, "..", "dist", "index.js");

/** mist-api from source, bundled as a plugin bundles it */
async function bundled() {
    const result = await Bun.build({ entrypoints: [join(import.meta.dir, "..", "src", "index.ts")], outdir: out, target: "node", format: "esm" });
    if (!result.success) throw new AggregateError(result.logs, "bundling mist-api failed");
    return result.outputs[0].path;
}

/** The fixture page's answers, over Node's inspector, with mist-api loaded from `entry` */
function page(entry: string) {
    return JSON.parse(execFileSync("node", [join(import.meta.dir, "fixtures", "cdp-page.ts"), entry], { encoding: "utf8" }));
}

type Answers = { call: unknown; logs: { args: unknown[]; }[]; handleLogs: unknown; concerns: Record<"clean" | "swapped" | "stopped", string[] | null>; };

function reachesTheCapability({ call, logs, handleLogs, concerns }: Answers) {
    expect(call).toBe("hi");
    expect(logs.map(l => l.args)).toEqual([["token abc-123"]]);
    expect(JSON.stringify(handleLogs)).not.toContain("abc-123");
    // What mist call checks before it sends arguments
    expect(concerns.clean).toEqual([]);
    expect(concerns.swapped).toEqual(["1 registration was refused while t-cdp's handle said it was running: two handles claim this id"]);
    expect(concerns.stopped).toEqual(["t-cdp-stopped's handle says the plugin isn't running"]);
}

test("the CLI reaches the plugin's real capability over CDP, whatever page code builds from the handle", async () => {
    reachesTheCapability(page(await bundled()));
}, 30_000);

// dist/ exists once `bun run build` ran, as in CI and before a publish
test.skipIf(!existsSync(built))("the built dist keeps the handle's private field, so the CLI reaches it the same way", () => {
    reachesTheCapability(page(built));
}, 30_000);
