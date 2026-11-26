import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError, open } from "../bin/cdp";

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

test("open gives up on a target that takes the connection and never answers the handshake", async () => {
    const sockets = new Set<Socket>();
    const server = createServer(socket => void sockets.add(socket));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number; };
    try {
        const started = Date.now();
        const failure = await open(`ws://127.0.0.1:${port}/`, 200).then(() => null, (err: Error) => err);
        expect(failure).toBeInstanceOf(CliError);
        expect(failure?.message).toContain("didn't finish opening within 200 ms");
        expect(Date.now() - started).toBeLessThan(5000);
    } finally {
        for (const socket of sockets) socket.destroy();
        server.close();
    }
});

/** A page that answers each command with an empty result, and on "Test.emit" sends a Test.event first */
function fakePage() {
    return Bun.serve({
        port: 0,
        fetch: (req, server) => server.upgrade(req) ? undefined : new Response("no", { status: 400 }),
        websocket: {
            message(ws, data) {
                const { id, method } = JSON.parse(String(data));
                if (method === "Test.emit") ws.send(JSON.stringify({ method: "Test.event", params: { n: 1 } }));
                ws.send(JSON.stringify({ id, result: {} }));
            },
        },
    });
}

test("a command on a closed connection fails at once, without a timer that keeps the process up", async () => {
    const server = fakePage();
    try {
        const conn = await open(`ws://127.0.0.1:${server.port}/`, 20_000);
        expect(await conn.send("Test.ping")).toEqual({});
        conn.close();
        const started = Date.now();
        const failure = await conn.send("Test.ping").then(() => null, (err: Error) => err);
        expect(failure).toBeInstanceOf(CliError);
        expect(failure?.message).toBe("Test.ping wasn't sent: the connection to the page is closed");
        expect(Date.now() - started).toBeLessThan(1000);
    } finally {
        server.stop(true);
    }
});

test("a listener that throws doesn't keep the event from the others", async () => {
    const server = fakePage();
    const errors: unknown[][] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
        const conn = await open(`ws://127.0.0.1:${server.port}/`, 20_000);
        const heard: unknown[] = [];
        conn.on("Test.event", () => { throw new Error("listener bug"); });
        conn.on("Test.event", params => heard.push(params));
        await conn.send("Test.emit");
        expect(heard).toEqual([{ n: 1 }]);
        expect(String(errors[0]?.[0])).toContain("a Test.event listener threw");
        conn.close();
    } finally {
        console.error = consoleError;
        server.stop(true);
    }
});
