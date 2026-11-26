import { Dispatcher, filters, find, type FluxAction } from "@evi/api";

import { checkDelay, isThenable, notifyEach } from "../internal.ts";
import { store, stores } from "../stores.ts";
import { isRecord } from "../util.ts";
import { snowflake } from "./snowflake.ts";

/** Discord's check of a saved login. For an "invalid" one, Discord asks for the password again. */
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

/** MultiAccountStore.getUsers(), parsed: an array or an object of entries, entries without an id dropped */
function parseAccounts(raw: unknown): SavedAccount[] {
    let entries: unknown[] = [];
    if (Array.isArray(raw)) entries = raw;
    else if (isRecord(raw)) entries = Object.values(raw);
    const seen = new Set<string>();
    const accounts: SavedAccount[] = [];
    for (const entry of entries) {
        if (!isRecord(entry) || !snowflake.is(entry.id) || seen.has(entry.id)) continue;
        seen.add(entry.id);
        accounts.push({
            id: entry.id,
            username: typeof entry.username === "string" && entry.username ? entry.username : entry.id,
            discriminator: typeof entry.discriminator === "string" && entry.discriminator ? entry.discriminator : "0",
            avatar: typeof entry.avatar === "string" && entry.avatar ? entry.avatar : null,
            // Discord's menu only acts on an invalid login: a status it might add later counts as valid
            status: STATUSES[String(entry.tokenStatus)] ?? "valid",
        });
    }
    return accounts;
}

interface MultiAccountSwitchStore {
    getIsSwitchingAccount?(): boolean;
    getTargetUserId?(): unknown;
}

const switchStore = () => store<MultiAccountSwitchStore>("MultiAccountSwitchStore");

const signedIn = (): string | undefined => {
    const id = stores.user?.getCurrentUser?.()?.id;
    return snowflake.is(id) ? id : undefined;
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
interface SessionState {
    account: string | undefined;
    switching: { from: string | undefined; to: string | undefined; } | undefined;
}

/** The Flux actions that move the session */
const ACTIONS = ["MULTI_ACCOUNT_SWITCH_START", "LOGOUT", "CONNECTION_OPEN"] as const;

/** What one Flux action does to the session, and the event it means, if any */
function nextSession(state: SessionState, action: FluxAction): [SessionState, AccountEvent | undefined] {
    switch (action.type) {
        case "MULTI_ACCOUNT_SWITCH_START": {
            const to = snowflake.is(action.targetUserId) ? action.targetUserId : undefined;
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
            const id = isRecord(action.user) && snowflake.is(action.user.id) ? action.user.id : undefined;
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
    // Logged, not thrown: thrown inside Discord's dispatch, it would stop the action reaching the handlers after ours
    notifyEach(listeners, [event], (_, err) => console.error(`accounts.on: a "${event.type}" listener threw:`, err));
}

function follow() {
    const sw = switchStore();
    const account = signedIn();
    const target = sw?.getTargetUserId?.();
    // A plugin can start in the middle of a switch: Discord's store knows, our listener doesn't yet
    session = {
        account,
        switching: sw?.getIsSwitchingAccount?.() === true ? { from: undefined, to: snowflake.is(target) ? target : undefined } : undefined,
    };
    for (const type of ACTIONS) Dispatcher.subscribe(type, onAction);
}

function unfollow() {
    for (const type of ACTIONS) Dispatcher.unsubscribe(type, onAction);
}

type SwitchFn = (id: string, synchronously?: boolean) => unknown;

/** How a switch went. "already": Discord was signed in as that account. "needsLogin": it has no login saved for it. */
export type SwitchResult = "switched" | "already" | "needsLogin" | "failed";

export interface SwitchOptions {
    /** Passed to Discord as its `switchSynchronously` argument. Left out, Discord does what its menu does. */
    synchronously?: boolean;
}

type Cleanup = () => void;

/** Work for one signed-in account. May return a cleanup, which runs when the account leaves. */
export type AccountRun = (accountId: string, signal: AbortSignal) => void | Cleanup | Promise<void | Cleanup>;

export interface ScopeOptions {
    /** How long after Discord connects to wait before `run`, for its stores to fill. Not waited when it is connected already. Default 0 */
    settleMs?: number;
}

/** One account's turn in a scope */
interface ScopeRun {
    id: string;
    controller: AbortController;
    timer?: ReturnType<typeof setTimeout>;
    cleanup?: Cleanup;
}

const logScopeError = (what: string) => (err: unknown) => console.error(`accounts.scope: ${what} threw:`, err);
const runFailed = logScopeError("run");
const cleanupFailed = logScopeError("cleanup");

function cleanUp(cleanup: Cleanup) {
    try {
        cleanup();
    } catch (err) {
        cleanupFailed(err);
    }
}

/** The runs behind `accounts.scope`: one at a time, for the account Discord is connected as */
class AccountScope {
    private current: ScopeRun | undefined;
    private readonly offs: (() => void)[];

    constructor(private readonly run: AccountRun, private readonly settleMs: number) {
        this.offs = [
            accounts.on("connected", ({ id }) => {
                if (this.current?.id === id) return;
                this.end();
                this.start(id, this.settleMs);
            }),
            accounts.on("switching", () => this.end()),
            accounts.on("signedOut", () => this.end()),
        ];
        const now = signedIn();
        if (now) this.start(now, 0);
    }

    stop() {
        for (const off of this.offs.splice(0)) off();
        this.end();
    }

    private start(id: string, delay: number) {
        const turn: ScopeRun = { id, controller: new AbortController() };
        this.current = turn;
        if (delay > 0) turn.timer = setTimeout(() => this.begin(turn), delay);
        else this.begin(turn);
    }

    private begin(turn: ScopeRun) {
        const keep = (result: void | Cleanup) => {
            if (typeof result !== "function") return;
            if (turn.controller.signal.aborted) cleanUp(result);
            else turn.cleanup = result;
        };
        try {
            const result = this.run(turn.id, turn.controller.signal);
            // Any thenable, not only this realm's Promise
            if (isThenable(result)) result.then(keep, runFailed);
            else keep(result);
        } catch (err) {
            runFailed(err);
        }
    }

    private end() {
        const turn = this.current;
        this.current = undefined;
        if (!turn) return;
        clearTimeout(turn.timer);
        turn.controller.abort(new DOMException("Account changed", "AbortError"));
        if (turn.cleanup) cleanUp(turn.cleanup);
    }
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
        return snowflake.is(target) ? target : undefined;
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
     * Switches to a saved account with Discord's switch, as its Switch Accounts menu does, and says how
     * it went. Resolves when Discord has taken the account's login, before it connects: await
     * `whenConnected()` for that. On "needsLogin", `openLogin()` lets the user sign in again. An error
     * from Discord's switch is logged to the console, and answered "failed".
     */
    async switchTo(id: string, { synchronously }: SwitchOptions = {}): Promise<SwitchResult> {
        snowflake.assert(id, "accounts.switchTo: id");
        const discordSwitch = find<SwitchFn>(filters.byCode("Switching account to", "MULTI_ACCOUNT_SWITCH_START"));
        if (typeof discordSwitch !== "function") throw new Error("accounts.switchTo: Discord's account switch isn't available");
        if (signedIn() === id) return "already";
        try {
            // Discord's switchAccountToken resolves true or false, and undefined when it has no token saved for the account
            const answer = await (synchronously === undefined ? discordSwitch(id) : discordSwitch(id, synchronously));
            if (answer === true) return "switched";
            if (answer === undefined) return "needsLogin";
            return "failed";
        } catch (err) {
            console.error("accounts.switchTo: Discord's switch threw:", err);
            return "failed";
        }
    },

    /** Opens Discord's "add an account" login, as its Switch Accounts menu does. False when Discord's function isn't there. */
    openLogin(): boolean {
        const login = find<() => void>(filters.byCode("onBackPressed:", "LOGIN_RESET"));
        if (typeof login !== "function") return false;
        login();
        return true;
    },

    /**
     * Runs `run(accountId, signal)` for each account Discord connects as: at once when it is connected
     * already, else `settleMs` after it connects. When the account switches or signs out, the signal
     * aborts with an AbortError and the cleanup `run` returned is called. An error from `run` or its
     * cleanup is logged to the console, not thrown into Discord's dispatch. Returns the stop, which
     * also ends the current run; it can go to `ctx.onDispose`.
     */
    scope(run: AccountRun, { settleMs = 0 }: ScopeOptions = {}): () => void {
        if (typeof run !== "function") throw new TypeError("accounts.scope: run must be a function to run for each account");
        checkDelay("accounts.scope", "settleMs", settleMs);
        const scope = new AccountScope(run, settleMs);
        return () => scope.stop();
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
