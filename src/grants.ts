/**
 * Paths the person picked in a file dialog, handed to the page as opaque handles. The page can hold
 * and pass a handle back, but only the native side turns it into a path, so page code can't make
 * native code read or write a path nobody picked.
 */
import type { NativeContext } from "@evi/api/native";
import { dialog, type OpenDialogOptions } from "electron";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { NativeError } from "./errors.ts";
import { openJson } from "./files.ts";
import { isRecord } from "./util.ts";
import { discordWindow } from "./window.ts";

/** An opaque id for a picked path. Safe to give the page; it means nothing outside this plugin's native side. */
export type GrantHandle = string & { readonly __grant: unique symbol; };

export interface PickOptions {
    title?: string;
    buttonLabel?: string;
    defaultPath?: string;
    /** File type filters, as Electron's: `[{ name: "Images", extensions: ["png", "jpg"] }]` */
    filters?: { name: string; extensions: string[]; }[];
}

interface Grant { kind: "file" | "folder"; path: string; }

export interface PathGrants {
    /** Shows an open-file dialog over Discord's window. Null when the person cancels. */
    pickFile(options?: PickOptions): Promise<GrantHandle | null>;
    /** Shows a choose-folder dialog over Discord's window. Null when the person cancels. */
    pickFolder(options?: PickOptions): Promise<GrantHandle | null>;
    /**
     * The path behind `handle`, which may come from the page. For a folder, `segments` name a path
     * inside it; one that leads outside the folder throws. Throws a NativeError "unknown-grant" for a
     * handle this plugin never gave out or has revoked.
     */
    resolveGrant(handle: unknown, ...segments: unknown[]): string;
    /** Forgets a handle. True when it existed. */
    revokeGrant(handle: unknown): boolean;
}

const HANDLE = /^grant:[0-9a-f-]{36}$/;

/**
 * Path grants kept in `mist-grants.json` in the plugin's folder, so a handle the page saved still
 * resolves after Discord restarts, until it's revoked.
 */
export function pathGrants(ctx: NativeContext): PathGrants {
    const file = openJson<Record<string, Grant>>(ctx, "mist-grants", {
        initial: {},
        parse: raw => isRecord(raw)
            ? Object.fromEntries(Object.entries(raw).filter(([handle, g]) => HANDLE.test(handle) && isRecord(g) && (g.kind === "file" || g.kind === "folder") && typeof g.path === "string" && isAbsolute(g.path))) as Record<string, Grant>
            : {},
        debounceMs: 0,
    });

    async function pick(kind: Grant["kind"], { title, buttonLabel, defaultPath, filters }: PickOptions = {}): Promise<GrantHandle | null> {
        const options: OpenDialogOptions = { title, buttonLabel, defaultPath, filters, properties: [kind === "file" ? "openFile" : "openDirectory"] };
        const parent = discordWindow();
        const { canceled, filePaths } = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options));
        if (canceled || !filePaths[0]) return null;
        const handle = `grant:${crypto.randomUUID()}` as GrantHandle;
        const grant: Grant = { kind, path: resolve(filePaths[0]) };
        file.set(all => ({ ...all, [handle]: grant }));
        return handle;
    }

    const lookup = (handle: unknown) => {
        const grant = typeof handle === "string" && HANDLE.test(handle) ? file.get()[handle] : undefined;
        if (!grant) throw new NativeError("unknown-grant", undefined, "No such path grant");
        return grant;
    };

    return {
        pickFile: options => pick("file", options),
        pickFolder: options => pick("folder", options),
        resolveGrant(handle, ...segments) {
            const grant = lookup(handle);
            if (!segments.length) return grant.path;
            if (grant.kind === "file") throw new NativeError("outside-grant", undefined, "A file grant has nothing inside it");
            if (!segments.every(s => typeof s === "string")) throw new NativeError("outside-grant", undefined, "Path segments are strings");
            const full = resolve(grant.path, ...segments as string[]);
            const rel = relative(grant.path, full);
            if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new NativeError("outside-grant", undefined, "That path is outside the granted folder");
            return full;
        },
        revokeGrant(handle) {
            if (typeof handle !== "string" || !Object.hasOwn(file.get(), handle)) return false;
            file.set(({ [handle]: _, ...rest }) => rest);
            return true;
        },
    };
}
