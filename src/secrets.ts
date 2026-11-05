/** Strings kept encrypted with Electron's safeStorage in the plugin's own folder. */
import type { NativeContext } from "@evi/api/native";
import { safeStorage } from "electron";

import { NativeError } from "./errors.ts";
import { openJson } from "./files.ts";
import { isRecord } from "./util.ts";

export interface Secrets {
    /**
     * Whether safeStorage encrypts with a key the OS keeps (Keychain, DPAPI, a Linux keyring). False
     * on Linux without a keyring, where Electron falls back to a key built into Chromium (basic_text),
     * which anyone who can read the file can undo.
     */
    readonly encrypted: boolean;
    get(name: string): string | undefined;
    set(name: string, value: string): void;
    /** True when there was a secret by that name */
    delete(name: string): boolean;
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

function checkName(name: unknown): asserts name is string {
    if (typeof name !== "string" || !NAME.test(name)) throw new NativeError("bad-name", undefined, `Bad secret name ${JSON.stringify(name)}: 1 to 100 letters, digits, _ . and -`);
}

function available() {
    if (!safeStorage.isEncryptionAvailable()) throw new NativeError("secrets-unavailable", undefined, "Electron's safeStorage can't encrypt here");
}

/**
 * Secrets in `mist-secrets.json` in the plugin's folder (dataFolder), each encrypted with
 * safeStorage. Every native module runs in the same main process, so another plugin's native code
 * can call safeStorage too and read this file: this keeps secrets from someone who copies the file,
 * not from other plugins.
 */
export function secrets(ctx: NativeContext): Secrets {
    const file = openJson<Record<string, string>>(ctx, "mist-secrets", {
        initial: {},
        parse: raw => isRecord(raw) ? Object.fromEntries(Object.entries(raw).filter(([k, v]) => NAME.test(k) && typeof v === "string")) as Record<string, string> : {},
        debounceMs: 0,
    });
    return {
        get encrypted() {
            if (!safeStorage.isEncryptionAvailable()) return false;
            return process.platform !== "linux" || !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend());
        },
        get(name) {
            checkName(name);
            const all = file.get();
            if (!Object.hasOwn(all, name)) return undefined;
            const stored = all[name];
            available();
            try {
                return safeStorage.decryptString(Buffer.from(stored, "base64"));
            } catch (err) {
                throw new NativeError("secret-unreadable", { name }, `Can't decrypt the secret ${name}: ${err instanceof Error ? err.message : err}`);
            }
        },
        set(name, value) {
            checkName(name);
            if (typeof value !== "string") throw new NativeError("bad-value", undefined, "A secret is a string");
            available();
            const stored = safeStorage.encryptString(value).toString("base64");
            file.set(all => ({ ...all, [name]: stored }));
        },
        delete(name) {
            checkName(name);
            if (!Object.hasOwn(file.get(), name)) return false;
            file.set(({ [name]: _, ...rest }) => rest);
            return true;
        },
    };
}
