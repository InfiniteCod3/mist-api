/** mist restart: Discord again, with its debugging port open */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { CliError, sleep } from "./cdp.ts";

/** Discord's Update.exe on Windows, under %LOCALAPPDATA%\Discord */
export function discordUpdater(localAppData: string | undefined): string {
    if (!localAppData) throw new CliError("LOCALAPPDATA isn't set: mist restart can't find Discord's Update.exe. Start Discord with --remote-debugging-port yourself.");
    const update = join(localAppData, "Discord", "Update.exe");
    if (!existsSync(update)) throw new CliError(`No Discord installer at ${update}`);
    return update;
}

/** Resolves once Discord is started again, or the command to do that is printed */
export async function restart(port: number, dryRun: boolean): Promise<void> {
    const flag = `--remote-debugging-port=${port}`;
    if (process.platform !== "win32") {
        const command = process.platform === "darwin"
            ? `osascript -e 'quit app "Discord"'; open -a Discord --args ${flag}`
            : `pkill -x Discord; discord ${flag} &`;
        console.log(`Run this to restart Discord with its debugging port:\n  ${command}`);
        return;
    }
    const update = discordUpdater(process.env.LOCALAPPDATA);
    const kill = ["taskkill", ["/IM", "Discord.exe", "/F"]] as const;
    const start = [update, ["--processStart", "Discord.exe", "--process-start-args", flag]] as const;
    if (dryRun) {
        for (const [cmd, args] of [kill, start]) console.log([cmd, ...args].map(word => word.includes(" ") ? `"${word}"` : word).join(" "));
        return;
    }
    await new Promise(resolve => spawn(kill[0], kill[1], { stdio: "ignore" }).on("exit", resolve));
    // Discord takes a moment to let go of its single-instance lock
    await sleep(1500);
    spawn(start[0], start[1], { detached: true, stdio: "ignore" }).unref();
    console.log(`Discord restarts with ${flag}`);
}
