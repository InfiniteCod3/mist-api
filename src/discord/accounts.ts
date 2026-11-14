import { Dispatcher, filters, find, findStore, type FluxAction } from "@evi/api";

import { stores } from "../stores.ts";
import { isRecord } from "../util.ts";

/** Discord's check of a saved account's login: "invalid" means Discord will ask for the password again */
export type TokenStatus = "valid" | "validating" | "invalid";

/** A saved account from Discord's Switch Accounts list. Only profile fields: the store's tokens are never copied. */
export interface SavedAccount {
    id: string;
    username: string;
    /** "0" for accounts with the new usernames */
    discriminator: string;
    avatar: string | null;
    status: TokenStatus;
}

const STATUSES: Record<string, TokenStatus> = { 0: "invalid", 1: "validating", 2: "valid", INVALID: "invalid", VALIDATING: "validating", VALID: "valid" };

const isId = (value: unknown): value is string => typeof value === "string" && /^\d{1,20}$/.test(value);

/** MultiAccountStore.getUsers(), parsed: an array or an object of entries, entries without an id dropped */
export function parseAccounts(raw: unknown): SavedAccount[] {
    const entries: unknown[] = Array.isArray(raw) ? raw : isRecord(raw) ? Object.values(raw) : [];
    const seen = new Set<string>();
    const accounts: SavedAccount[] = [];
    for (const entry of entries) {
        if (!isRecord(entry) || !isId(entry.id) || seen.has(entry.id)) continue;
        seen.add(entry.id);
        accounts.push({
            id: entry.id,
            username: typeof entry.username === "string" && entry.username ? entry.username : entry.id,
            discriminator: typeof entry.discriminator === "string" && entry.discriminator ? entry.discriminator : "0",
            avatar: typeof entry.avatar === "string" && entry.avatar ? entry.avatar : null,
            // Discord's own menu only acts on an invalid login, so a status it might add later counts as valid
            status: STATUSES[String(entry.tokenStatus)] ?? "valid",
        });
    }
    return accounts;
}

interface MultiAccountSwitchStore {
    getIsSwitchingAccount?(): boolean;
    getTargetUserId?(): unknown;
}

function switchStore() {
    try {
        return findStore<MultiAccountSwitchStore>("MultiAccountSwitchStore");
    } catch {
        return undefined;
    }
}

const signedIn = (): string | undefined => {
    const id = stores.user?.getCurrentUser?.()?.id;
    return isId(id) ? id : undefined;
};

export interface AccountEvents {
    /** A switch began. `to` is undefined when Discord switched without saying where to. */
    switching: { from: string | undefined; to: string | undefined; };
    /** Logged out, not to switch. `id` is the account that was signed in, when known. */
    signedOut: { id: string | undefined; };
    /** Discord connected as `id`. `from` is the account a switch left, undefined when this wasn't a switch. */
    connected: { id: string; from: string | undefined; };
}

export type AccountEvent = { [K in keyof AccountEvents]: { type: K; } & AccountEvents[K] }[keyof AccountEvents];

/** The last account Discord connected as, and the switch under way, if any */
export interface SessionState {
    account: string | undefined;
    switching: { from: string | undefined; to: string | undefined; } | undefined;
}

/** What one Flux action does to the session, and the event it means, if any */
export function nextSession(state: SessionState, action: FluxAction): [SessionState, AccountEvent | undefined] {
    switch (action.type) {
        case "MULTI_ACCOUNT_SWITCH_START": {
            const to = isId(action.targetUserId) ? action.targetUserId : undefined;
            if (state.switching) return [{ ...state, switching: { ...state.switching, to: to ?? state.switching.to } }, undefined];
            const switching = { from: state.account, to };
            return [{ ...state, switching }, { type: "switching", ...switching }];
        }
        case "LOGOUT": {
            if (action.isSwitchingAccount) {
                if (state.switching) return [state, undefined];
                const switching = { from: state.account, to: undefined };
                return [{ ...state, switching }, { type: "switching", ...switching }];
            }
            return [{ account: undefined, switching: undefined }, { type: "signedOut", id: state.account }];
        }
        case "CONNECTION_OPEN": {
            const id = isRecord(action.user) && isId(action.user.id) ? action.user.id : undefined;
            if (!id) return [state, undefined];
            return [{ account: id, switching: undefined }, { type: "connected", id, from: state.switching?.from }];
        }
    }
    return [state, undefined];
}

type Listener = (event: AccountEvent) => void;
const listeners = new Set<Listener>();
let session: SessionState = { account: undefined, switching: undefined };

function onAction(action: FluxAction) {
    const [next, event] = nextSession(session, action);
    session = next;
    if (!event) return;
    for (const listener of [...listeners]) {
        try {
            listener(event);
        } catch (err) {
            // Thrown from inside Discord's dispatch, it would stop the action reaching the handlers after ours
            reportError(err);
        }
    }
}

function follow() {
    const sw = switchStore();
    const account = signedIn();
    const target = sw?.getTargetUserId?.();
    // A plugin can start in the middle of a switch: Discord's store knows, our listener doesn't yet
    session = {
        account,
        switching: sw?.getIsSwitchingAccount?.() === true ? { from: undefined, to: isId(target) ? target : undefined } : undefined,
    };
    Dispatcher.subscribe("MULTI_ACCOUNT_SWITCH_START", onAction);
    Dispatcher.subscribe("LOGOUT", onAction);
    Dispatcher.subscribe("CONNECTION_OPEN", onAction);
}

function unfollow() {
    Dispatcher.unsubscribe("MULTI_ACCOUNT_SWITCH_START", onAction);
    Dispatcher.unsubscribe("LOGOUT", onAction);
    Dispatcher.unsubscribe("CONNECTION_OPEN", onAction);
}

type SwitchFn = (id: string, synchronously?: boolean) => unknown;

/** What Discord answered a switch: "already" when it was signed in as that account, "needsLogin" when it has no login saved for it */
export type SwitchResult = "switched" | "already" | "needsLogin" | "failed";

export interface SwitchOptions {
    /** Passed to Discord as its own `switchSynchronously` argument. Left out, Discord does what its menu does. */
    synchronously?: boolean;
}

/** Work for one signed-in account. May return a cleanup, which runs when the account leaves. */
export type AccountRun = (accountId: string, signal: AbortSignal) => void | (() => void) | Promise<void | (() => void)>;

export interface ScopeOptions {
    /** How long after Discord connects to wait before `run`, for its stores to fill. Not waited when it is connected already. Default 0 */
    settleMs?: number;
}

export const accounts = {
    /** The saved accounts in Discord's order. Empty while Discord hasn't made its store. */
    list(): SavedAccount[] {
        try {
            return parseAccounts(stores.multiAccount?.getUsers());
        } catch {
            return [];
        }
    },

    /**
     * The account Discord is signed in as. While it switches, and its UserStore is empty, the account
     * it is switching to. Undefined when logged out, or before Discord knows.
     */
    current(): string | undefined {
        const id = signedIn();
        if (id) return id;
        const sw = switchStore();
        const target = sw?.getIsSwitchingAccount?.() === true ? sw.getTargetUserId?.() : undefined;
        return isId(target) ? target : undefined;
    },

    /** Calls `listener` on each `event`. Returns the unsubscribe, which can go to `ctx.onDispose`. */
    on<E extends keyof AccountEvents>(event: E, listener: (detail: AccountEvents[E]) => void): () => void {
        const filtered: Listener = e => {
            if (e.type === event) listener(e as AccountEvents[E] & AccountEvent);
        };
        if (!listeners.size) follow();
        listeners.add(filtered);
        return () => {
            if (!listeners.delete(filtered) || listeners.size) return;
            unfollow();
        };
    },

    /**
     * Switches to a saved account with Discord's own switch, as its Switch Accounts menu does, and says
     * how it went. Resolves when Discord has taken the account's login, before it connects: await
     * `whenConnected()` for that. On "needsLogin", `openLogin()` lets the user sign in again.
     */
    async switchTo(id: string, { synchronously }: SwitchOptions = {}): Promise<SwitchResult> {
        if (!isId(id)) throw new TypeError(`An account id is a Discord id, got ${JSON.stringify(id)}`);
        const discordSwitch = find<SwitchFn>(filters.byCode("Switching account to", "MULTI_ACCOUNT_SWITCH_START"));
        if (typeof discordSwitch !== "function") throw new Error("Discord's account switch isn't available");
        if (signedIn() === id) return "already";
        try {
            // Discord's switchAccountToken resolves true or false, and undefined when it has no token saved for the account
            const answer = await (synchronously === undefined ? discordSwitch(id) : discordSwitch(id, synchronously));
            return answer === true ? "switched" : answer === undefined ? "needsLogin" : "failed";
        } catch {
            return "failed";
        }
    },

    /** Opens Discord's own "add an account" login, as its Switch Accounts menu does. False when Discord's function isn't there. */
    openLogin(): boolean {
        const login = find<() => void>(filters.byCode("onBackPressed:", "LOGIN_RESET"));
        if (typeof login !== "function") return false;
        login();
        return true;
    },

    /**
     * Runs `run(accountId, signal)` for each account Discord connects as: at once when it is connected
     * already, else `settleMs` after it connects. When the account switches or signs out, the signal
     * aborts and the cleanup `run` returned is called. An error from `run` or its cleanup is reported,
     * not thrown into Discord's dispatch. Returns the stop, which also ends the current run; it can go
     * to `ctx.onDispose`.
     */
    scope(run: AccountRun, { settleMs = 0 }: ScopeOptions = {}): () => void {
        if (typeof run !== "function") throw new TypeError("accounts.scope takes a function to run for each account");
        let current: { id: string; controller: AbortController; timer?: ReturnType<typeof setTimeout>; cleanup?: () => void; } | undefined;
        const cleanUp = (cleanup: () => void) => {
            try { cleanup(); } catch (err) { reportError(err); }
        };
        const begin = (state: NonNullable<typeof current>) => {
            const keep = (result: unknown) => {
                if (typeof result !== "function") return;
                if (state.controller.signal.aborted) cleanUp(result as () => void);
                else state.cleanup = result as () => void;
            };
            try {
                const result = run(state.id, state.controller.signal);
                if (result instanceof Promise) result.then(keep, reportError);
                else keep(result);
            } catch (err) {
                reportError(err);
            }
        };
        const start = (id: string, delay: number) => {
            const state: NonNullable<typeof current> = { id, controller: new AbortController() };
            current = state;
            if (delay > 0) state.timer = setTimeout(() => begin(state), delay);
            else begin(state);
        };
        const end = () => {
            const state = current;
            current = undefined;
            if (!state) return;
            clearTimeout(state.timer);
            state.controller.abort(new Error(`Account ${state.id} left`));
            if (state.cleanup) cleanUp(state.cleanup);
        };
        const offs = [
            accounts.on("connected", ({ id }) => {
                if (current?.id === id) return;
                end();
                start(id, settleMs);
            }),
            accounts.on("switching", end),
            accounts.on("signedOut", end),
        ];
        const now = signedIn();
        if (now) start(now, 0);
        return () => {
            for (const off of offs.splice(0)) off();
            end();
        };
    },
};

/** The account id once Discord is connected; at once when it already is. Rejects with the signal's reason. */
export function whenConnected(signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const now = signedIn();
        if (now) return resolve(now);
        const onAbort = () => {
            off();
            reject(signal!.reason);
        };
        const off = accounts.on("connected", ({ id }) => {
            off();
            signal?.removeEventListener("abort", onAbort);
            resolve(id);
        });
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
