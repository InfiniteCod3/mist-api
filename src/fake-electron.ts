/** A stand-in for Electron's main-process module, for a test's module mock of "electron". */
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** A webContents: its URL, events, and the window-open handler set on it */
export interface FakeWebContents extends EventEmitter {
    readonly id: number;
    getURL(): string;
    getTitle(): string;
    isDestroyed(): boolean;
    loadURL(url: string): Promise<void>;
    setWindowOpenHandler(handler: (details: { url: string; }) => { action: "allow" | "deny"; }): void;
    /** The handler from setWindowOpenHandler, to check that popups are denied */
    readonly windowOpenHandler: ((details: { url: string; }) => { action: "allow" | "deny"; }) | undefined;
    setAudioMuted(muted: boolean): void;
    isAudioMuted(): boolean;
}

export interface FakeBrowserWindow extends EventEmitter {
    readonly id: number;
    /** What `new BrowserWindow(options)` was given; `{}` for a window from addWindow */
    readonly options: Record<string, any>;
    readonly webContents: FakeWebContents;
    /** Every URL loadURL was given, oldest first */
    readonly loaded: string[];
    loadURL(url: string): Promise<void>;
    /**
     * What a test calls for the page going to `url`: emits "will-navigate" with an event the code can
     * preventDefault, and if it doesn't, sets the URL and emits "did-navigate". Returns whether it went.
     */
    navigate(url: string): boolean;
    /** The user closing the window: emits "close", and unless that is prevented, destroys it */
    close(): void;
    /** Emits "closed" on the window, once */
    destroy(): void;
    isDestroyed(): boolean;
    focus(): void;
    blur(): void;
    isFocused(): boolean;
    show(): void;
    hide(): void;
    isVisible(): boolean;
    minimize(): void;
    restore(): void;
    isMinimized(): boolean;
    getBounds(): Rect;
    setBounds(bounds: Partial<Rect>): void;
    getTitle(): string;
    setTitle(title: string): void;
    removeMenu(): void;
    readonly menuRemoved: boolean;
    flashFrame(flag: boolean): void;
}

export interface FakeBrowserWindowClass {
    new(options?: Record<string, any>): FakeBrowserWindow;
    /** The windows not destroyed, oldest first */
    getAllWindows(): FakeBrowserWindow[];
    fromId(id: number): FakeBrowserWindow | null;
    getFocusedWindow(): FakeBrowserWindow | null;
}

export interface FakeCookie {
    name: string;
    value: string;
    domain: string;
    hostOnly: boolean;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    session: boolean;
    expirationDate?: number;
}

export interface FakeCookieDetails {
    url: string;
    name?: string;
    value?: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    expirationDate?: number;
}

/** A session's cookie jar. Emits "changed" (event, cookie, cause, removed) as Electron's does. */
export interface FakeCookies extends EventEmitter {
    get(filter?: { url?: string; name?: string; domain?: string; path?: string; }): Promise<FakeCookie[]>;
    set(details: FakeCookieDetails): Promise<void>;
    remove(url: string, name: string): Promise<void>;
    flushStore(): Promise<void>;
    /** How many times flushStore ran */
    readonly flushes: number;
}

export type PermissionRequestHandler = (contents: unknown, permission: string, callback: (granted: boolean) => void, details?: unknown) => void;
export type PermissionCheckHandler = (contents: unknown, permission: string, origin?: string, details?: unknown) => boolean;

export interface FakeSession {
    readonly partition: string;
    readonly cookies: FakeCookies;
    /** Answered by the fake's `fetch`, and recorded in `fetched` */
    fetch(url: string, init?: RequestInit): Promise<Response>;
    readonly fetched: { url: string; init?: RequestInit; }[];
    setPermissionRequestHandler(handler: PermissionRequestHandler | null): void;
    setPermissionCheckHandler(handler: PermissionCheckHandler | null): void;
    /** The handlers set, to check what the code allows */
    readonly permissionRequestHandler: PermissionRequestHandler | null;
    readonly permissionCheckHandler: PermissionCheckHandler | null;
    getUserAgent(): string;
    setUserAgent(userAgent: string): void;
    /** Removes every cookie */
    clearStorageData(): Promise<void>;
    clearCache(): Promise<void>;
    /** How many times clearStorageData ran */
    readonly clears: number;
}

/** What a test's module mock returns for "electron": the parts the fake has */
export interface FakeElectronModule {
    app: EventEmitter & { getPath(name: string): string; getVersion(): string; };
    BrowserWindow: FakeBrowserWindowClass;
    session: { fromPartition(partition: string): FakeSession; readonly defaultSession: FakeSession; };
    shell: { openExternal(url: string): Promise<void>; };
    dialog: {
        showOpenDialog(parentOrOptions: unknown, options?: unknown): Promise<{ canceled: boolean; filePaths: string[]; }>;
        showSaveDialog(parentOrOptions: unknown, options?: unknown): Promise<{ canceled: boolean; filePath: string; }>;
        showMessageBox(parentOrOptions: unknown, options?: unknown): Promise<{ response: number; checkboxChecked: boolean; }>;
    };
    /** Not encryption: a reversible stand-in for testing code that stores secrets */
    safeStorage: {
        isEncryptionAvailable(): boolean;
        getSelectedStorageBackend(): string;
        encryptString(text: string): Uint8Array;
        decryptString(data: Uint8Array): string;
    };
}

export interface FakeElectronOptions {
    /** Answers every session's fetch. Default a 404. It can be changed later through `fetch`. */
    fetch?: (url: string, init: RequestInit | undefined, partition: string) => Response | Promise<Response>;
    /** Each session's starting user agent. Default a Discord desktop one, with Electron and discord tokens */
    userAgent?: string;
    /** What app.getPath answers, by name. Default `/fake/<name>` */
    paths?: Record<string, string>;
}

export interface FakeElectron {
    /** Return this from the module mock: `mock.module("electron", () => electron.module)` */
    readonly module: FakeElectronModule;
    /** Every window, from addWindow and `new BrowserWindow`, destroyed ones too, oldest first */
    readonly windows: FakeBrowserWindow[];
    /** Adds a window that is already open, such as Discord's main window at `https://discord.com/app` */
    addWindow(options?: { url?: string; bounds?: Partial<Rect>; }): FakeBrowserWindow;
    /** Answers every session's fetch */
    fetch: (url: string, init: RequestInit | undefined, partition: string) => Response | Promise<Response>;
    /** Each session fromPartition made, by partition */
    readonly sessions: Map<string, FakeSession>;
    /** Each URL shell.openExternal was given, oldest first */
    readonly opened: string[];
    /** What the next dialog of each kind answers */
    dialogAnswers: {
        open: { canceled: boolean; filePaths: string[]; };
        save: { canceled: boolean; filePath: string; };
        message: { response: number; checkboxChecked: boolean; };
    };
    /** Each dialog shown, with its parent window (null for none) and options */
    readonly dialogCalls: { kind: "open" | "save" | "message"; parent: unknown; options: Record<string, any>; }[];
    /** What safeStorage.isEncryptionAvailable answers. Default true */
    encryptionAvailable: boolean;
    /** What safeStorage.getSelectedStorageBackend answers. Default "gnome_libsecret" */
    storageBackend: string;
    /** Destroys every window, empties the sessions, opened links and dialog calls, and resets the answers */
    reset(): void;
}

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9200 Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36";

/** Object.assign that keeps getters as getters: a fake's `flushes` or `menuRemoved` stays live */
function extend<T extends object, U extends object>(target: T, source: U): T & U {
    return Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)) as T & U;
}

function domainMatches(host: string, cookie: FakeCookie) {
    if (cookie.hostOnly) return host === cookie.domain;
    const domain = cookie.domain.replace(/^\./, "");
    return host === domain || host.endsWith(`.${domain}`);
}

/** A cookie's domain is `domain` or under it, as Electron's `domain` filter takes it */
function underDomain(cookie: FakeCookie, domain: string) {
    const have = cookie.domain.replace(/^\./, ""), wanted = domain.replace(/^\./, "");
    return have === wanted || have.endsWith(`.${wanted}`);
}

function cookieJar(): { cookies: FakeCookies; clear(): void; } {
    const jar: FakeCookie[] = [];
    let flushes = 0;
    const emitter = new EventEmitter();
    const find = (url: string, name: string) => {
        const host = new URL(url).hostname;
        return jar.findIndex(c => c.name === name && domainMatches(host, c));
    };
    const cookies: FakeCookies = extend(emitter, {
        async get(filter: { url?: string; name?: string; domain?: string; path?: string; } = {}) {
            const url = filter.url ? new URL(filter.url) : undefined;
            return jar.filter(c =>
                (!url || (domainMatches(url.hostname, c) && url.pathname.startsWith(c.path) && (!c.secure || url.protocol === "https:")))
                && (filter.name === undefined || c.name === filter.name)
                && (filter.domain === undefined || underDomain(c, filter.domain))
                && (filter.path === undefined || c.path === filter.path)).map(c => ({ ...c }));
        },
        async set(details: FakeCookieDetails) {
            const url = new URL(details.url);
            const cookie: FakeCookie = {
                name: details.name ?? "",
                value: details.value ?? "",
                domain: details.domain ?? url.hostname,
                hostOnly: details.domain === undefined,
                path: details.path ?? "/",
                secure: details.secure ?? false,
                httpOnly: details.httpOnly ?? false,
                session: details.expirationDate === undefined,
                ...details.expirationDate !== undefined && { expirationDate: details.expirationDate },
            };
            const at = jar.findIndex(c => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path);
            if (at >= 0) jar.splice(at, 1, cookie);
            else jar.push(cookie);
            emitter.emit("changed", {}, { ...cookie }, "explicit", false);
        },
        async remove(url: string, name: string) {
            const at = find(url, name);
            if (at < 0) return;
            const [cookie] = jar.splice(at, 1);
            emitter.emit("changed", {}, cookie, "explicit", true);
        },
        async flushStore() {
            flushes++;
        },
        get flushes() {
            return flushes;
        },
    });
    return {
        cookies,
        clear() {
            for (const cookie of jar.splice(0)) emitter.emit("changed", {}, cookie, "explicit", true);
        },
    };
}

/**
 * A fake of Electron's main-process module, for native unit tests in any runner: windows, sessions
 * with a programmable fetch and a cookie jar, shell, dialog, safeStorage and app. It imports neither
 * Electron nor a test runner.
 */
export function fakeElectron(options: FakeElectronOptions = {}): FakeElectron {
    const windows: FakeBrowserWindow[] = [];
    const sessions = new Map<string, FakeSession>();
    const opened: string[] = [];
    const dialogCalls: FakeElectron["dialogCalls"] = [];
    const answers = () => ({
        open: { canceled: true, filePaths: [] as string[] },
        save: { canceled: true, filePath: "" },
        message: { response: 0, checkboxChecked: false },
    });
    let nextId = 1;
    let focused: FakeBrowserWindow | null = null;

    /** Gives a new window its state and methods as properties of the window itself: getters like `menuRemoved` stay live */
    function dress(target: EventEmitter, windowOptions: Record<string, any>, url: string) {
        const id = nextId++;
        let current = url, destroyed = false, visible = windowOptions.show !== false, minimized = false, menuRemoved = false, muted = false, readyShown = false;
        let title = typeof windowOptions.title === "string" ? windowOptions.title : "";
        let bounds: Rect = { x: windowOptions.x ?? 0, y: windowOptions.y ?? 0, width: windowOptions.width ?? 800, height: windowOptions.height ?? 600 };
        let openHandler: FakeWebContents["windowOpenHandler"];
        const loaded: string[] = [];

        const contents: FakeWebContents = extend(new EventEmitter(), {
            id,
            getURL: () => current,
            getTitle: () => title,
            isDestroyed: () => destroyed,
            loadURL: (to: string) => win.loadURL(to),
            setWindowOpenHandler: (handler: NonNullable<FakeWebContents["windowOpenHandler"]>) => void (openHandler = handler),
            get windowOpenHandler() { return openHandler; },
            setAudioMuted: (value: boolean) => void (muted = value),
            isAudioMuted: () => muted,
        });
        const win: FakeBrowserWindow = extend(target, {
            id,
            options: windowOptions,
            webContents: contents,
            loaded,
            async loadURL(to: string) {
                if (destroyed) throw new Error("Object has been destroyed");
                loaded.push(to);
                current = to;
                contents.emit("did-navigate", {}, to, 200, "OK");
                contents.emit("did-finish-load");
                if (!readyShown) {
                    readyShown = true;
                    win.emit("ready-to-show");
                }
            },
            navigate(to: string) {
                if (destroyed) return false;
                let prevented = false;
                contents.emit("will-navigate", { url: to, preventDefault: () => void (prevented = true) }, to);
                if (prevented) return false;
                current = to;
                contents.emit("did-navigate", {}, to, 200, "OK");
                return true;
            },
            close() {
                if (destroyed) return;
                let prevented = false;
                win.emit("close", { preventDefault: () => void (prevented = true) });
                if (!prevented) win.destroy();
            },
            destroy() {
                if (destroyed) return;
                destroyed = true;
                if (focused === win) focused = null;
                win.emit("closed");
            },
            isDestroyed: () => destroyed,
            focus() { focused = win; },
            blur() { if (focused === win) focused = null; },
            isFocused: () => focused === win,
            show() { visible = true; },
            hide() { visible = false; },
            isVisible: () => visible,
            minimize() { minimized = true; },
            restore() { minimized = false; },
            isMinimized: () => minimized,
            getBounds: () => ({ ...bounds }),
            setBounds(next: Partial<Rect>) { bounds = { ...bounds, ...next }; },
            getTitle: () => title,
            setTitle(next: string) { title = next; },
            removeMenu() { menuRemoved = true; },
            get menuRemoved() { return menuRemoved; },
            flashFrame() { },
        });
        windows.push(win);
    }

    // A class: `win instanceof BrowserWindow` holds as with Electron's
    interface BrowserWindow extends FakeBrowserWindow { }
    class BrowserWindow extends EventEmitter {
        static getAllWindows = () => windows.filter(w => !w.isDestroyed());
        static fromId = (id: number) => windows.find(w => w.id === id && !w.isDestroyed()) ?? null;
        static getFocusedWindow = () => focused && !focused.isDestroyed() ? focused : null;

        /** `url` is where a window from addWindow already is; Electron's constructor takes only options */
        constructor(windowOptions: Record<string, any> = {}, url = "") {
            super();
            dress(this, windowOptions, url);
        }
    }

    function makeSession(partition: string): FakeSession {
        const { cookies, clear } = cookieJar();
        const fetched: FakeSession["fetched"] = [];
        let userAgent = options.userAgent ?? USER_AGENT, clears = 0;
        let requestHandler: PermissionRequestHandler | null = null, checkHandler: PermissionCheckHandler | null = null;
        return {
            partition,
            cookies,
            fetched,
            async fetch(url, init) {
                fetched.push({ url, init });
                init?.signal?.throwIfAborted();
                return fake.fetch(url, init, partition);
            },
            setPermissionRequestHandler: handler => void (requestHandler = handler),
            setPermissionCheckHandler: handler => void (checkHandler = handler),
            get permissionRequestHandler() { return requestHandler; },
            get permissionCheckHandler() { return checkHandler; },
            getUserAgent: () => userAgent,
            setUserAgent: next => void (userAgent = next),
            async clearStorageData() {
                clears++;
                clear();
            },
            async clearCache() { },
            get clears() { return clears; },
        };
    }
    const fromPartition = (partition: string) => {
        let made = sessions.get(partition);
        if (!made) sessions.set(partition, made = makeSession(partition));
        return made;
    };

    const dialogCall = (kind: "open" | "save" | "message", parentOrOptions: unknown, maybeOptions: unknown) => {
        const [parent, dialogOptions] = maybeOptions === undefined ? [null, parentOrOptions] : [parentOrOptions, maybeOptions];
        dialogCalls.push({ kind, parent, options: (dialogOptions ?? {}) as Record<string, any> });
    };
    const KEY = 0x5a;
    // A Buffer, as Electron's is: code calls toString("base64") on it
    const xor = (bytes: Uint8Array) => Buffer.from(Uint8Array.from(bytes, b => b ^ KEY));

    const app = extend(new EventEmitter(), {
        getPath: (name: string) => options.paths?.[name] ?? `/fake/${name}`,
        getVersion: () => "1.0.9200",
    });

    const fake: FakeElectron = {
        windows,
        sessions,
        opened,
        dialogCalls,
        dialogAnswers: answers(),
        encryptionAvailable: true,
        storageBackend: "gnome_libsecret",
        fetch: options.fetch ?? (() => new Response("", { status: 404 })),
        addWindow({ url = "https://discord.com/app", bounds = {} } = {}) {
            return new BrowserWindow({ ...bounds }, url);
        },
        reset() {
            for (const win of windows.splice(0)) win.destroy();
            sessions.clear();
            opened.length = 0;
            dialogCalls.length = 0;
            fake.dialogAnswers = answers();
            fake.encryptionAvailable = true;
            fake.storageBackend = "gnome_libsecret";
            focused = null;
        },
        module: {
            app,
            BrowserWindow,
            session: {
                fromPartition,
                get defaultSession() { return fromPartition(""); },
            },
            shell: {
                async openExternal(url) {
                    opened.push(url);
                },
            },
            dialog: {
                async showOpenDialog(parentOrOptions, maybeOptions) {
                    dialogCall("open", parentOrOptions, maybeOptions);
                    return fake.dialogAnswers.open;
                },
                async showSaveDialog(parentOrOptions, maybeOptions) {
                    dialogCall("save", parentOrOptions, maybeOptions);
                    return fake.dialogAnswers.save;
                },
                async showMessageBox(parentOrOptions, maybeOptions) {
                    dialogCall("message", parentOrOptions, maybeOptions);
                    return fake.dialogAnswers.message;
                },
            },
            safeStorage: {
                isEncryptionAvailable: () => fake.encryptionAvailable,
                getSelectedStorageBackend: () => fake.storageBackend,
                encryptString(text) {
                    if (!fake.encryptionAvailable) throw new Error("Encryption is not available.");
                    return xor(Buffer.from(`v10${text}`));
                },
                decryptString(data) {
                    const text = xor(data).toString();
                    if (!text.startsWith("v10")) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
                    return text.slice(3);
                },
            },
        },
    };
    return fake;
}
