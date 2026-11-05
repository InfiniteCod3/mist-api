/** A stand-in for Electron's main-process module, preloaded for every test (bunfig.toml). Tests set `electron`'s fields. */
import { mock } from "bun:test";

export interface FakeWindow {
    id: number;
    url: string;
    destroyed?: boolean;
}

export const electron = {
    windows: [] as FakeWindow[],
    /** What the next open dialog answers, and the options and parent it was shown with */
    dialogAnswer: { canceled: true, filePaths: [] as string[] },
    dialogCalls: [] as { parent: unknown; options: { properties?: string[]; }; }[],
    encryptionAvailable: true,
    backend: "gnome_libsecret",
};

const asWindow = (w: FakeWindow) => ({
    id: w.id,
    isDestroyed: () => !!w.destroyed,
    webContents: { isDestroyed: () => !!w.destroyed, getURL: () => w.url },
});

const KEY = 0x5a;
const xor = (bytes: Buffer) => Buffer.from(bytes.map(b => b ^ KEY));

mock.module("electron", () => ({
    BrowserWindow: {
        getAllWindows: () => electron.windows.map(asWindow),
        fromId: (id: number) => {
            const found = electron.windows.find(w => w.id === id);
            return found ? asWindow(found) : null;
        },
    },
    dialog: {
        async showOpenDialog(parentOrOptions: unknown, maybeOptions?: unknown) {
            const [parent, options] = maybeOptions === undefined ? [null, parentOrOptions] : [parentOrOptions, maybeOptions];
            electron.dialogCalls.push({ parent, options: options as { properties?: string[]; } });
            return electron.dialogAnswer;
        },
    },
    safeStorage: {
        isEncryptionAvailable: () => electron.encryptionAvailable,
        getSelectedStorageBackend: () => electron.backend,
        encryptString(text: string) {
            if (!electron.encryptionAvailable) throw new Error("Encryption is not available.");
            return xor(Buffer.from(`v10${text}`));
        },
        decryptString(data: Buffer) {
            const text = xor(data).toString();
            if (!text.startsWith("v10")) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
            return text.slice(3);
        },
    },
}));
