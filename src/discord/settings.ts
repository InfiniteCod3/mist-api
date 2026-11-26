import { Dispatcher, type FluxAction } from "@evi/api";

import { checkTimeout, shownValue } from "../internal.ts";
import { checkApiRequest } from "../permissions.ts";
import { lookup, store } from "../stores.ts";
import { isRecord } from "../util.ts";
import { snowflake } from "./snowflake.ts";

/** Discord's two synced settings protos: most settings, and the favourites and recents ("frecency") */
export type SettingsProto = "preloaded" | "frecency";

const TYPE_NAMES: Record<SettingsProto, string> = {
    preloaded: "discord_protos.discord_users.v1.PreloadedUserSettings",
    frecency: "discord_protos.discord_users.v1.FrecencyUserSettings",
};

/** Discord's UserSettingsDelay.INFREQUENT_USER_ACTION: saved now, as after a click */
const SAVE_NOW = 0;

interface ProtoField { name?: string; localName?: string; T?: () => unknown; }
interface ProtoType { typeName?: string; fields?: { find?(test: (field: ProtoField) => boolean): ProtoField | undefined; }; create?(value: object): unknown; }

interface Updater {
    ProtoClass: ProtoType & { typeName: string; };
    type: number;
    updateAsync(group: string, change: (value: any) => unknown, delaySeconds: number, onError?: (error: unknown) => void): Promise<void>;
    loadIfNecessary?(force?: boolean): Promise<unknown>;
}

const updaterOf = (typeName: string) =>
    lookup<Updater>(v => v?.ProtoClass?.typeName === typeName && typeof v.updateAsync === "function" && typeof v.type === "number");

const updaters: Record<SettingsProto, () => Updater | undefined> = {
    preloaded: updaterOf(TYPE_NAMES.preloaded),
    frecency: updaterOf(TYPE_NAMES.frecency),
};

/** How a settings write ended: saved to the account, nothing to change, or not saved */
export type SaveResult = "saved" | "unchanged" | "failed";

export interface UpdateOptions {
    /** How long to wait for Discord to confirm the save, in ms: above 0 to 2147483647. Default 30000 */
    timeoutMs?: number;
}

/** The message type of `field` in the proto's group `group`, to build a value the proto's way */
function fieldType(proto: SettingsProto, group: string, field: string): ProtoType | undefined {
    try {
        const groupType = updaters[proto]()?.ProtoClass.fields?.find?.(f => f.name === group || f.localName === group)?.T?.() as ProtoType | undefined;
        return groupType?.fields?.find?.(f => f.localName === field || f.name === field)?.T?.() as ProtoType | undefined;
    } catch {
        return undefined;
    }
}

type Outcome = "saved" | "refused" | "timedOut";

/**
 * Changes one group of a settings proto with Discord's updater, which saves it to the account, and
 * waits for Discord to confirm the save. `change` edits the group's value in place; returning false
 * means nothing changed, and nothing is saved. A save Discord refused is undone locally, as Discord
 * would otherwise keep it queued. One unconfirmed after `timeoutMs` is left queued: reloading then
 * would drop it, with any other change waiting to save. `fn` starts error messages and console lines.
 */
export async function updateSettings<G = any>(
    plugin: string, proto: SettingsProto, group: string, change: (value: G) => boolean | void,
    { timeoutMs = 30_000 }: UpdateOptions = {}, fn = "settings.update",
): Promise<SaveResult> {
    if (!Object.hasOwn(TYPE_NAMES, proto)) throw new TypeError(`${fn}: proto must be "preloaded" or "frecency", got ${shownValue(proto)}`);
    if (typeof group !== "string" || !group) throw new TypeError(`${fn}: group must be a field name, as in "status", got ${shownValue(group)}`);
    if (typeof change !== "function") throw new TypeError(`${fn}: change must be a function that edits the group's value`);
    checkTimeout(fn, "timeoutMs", timeoutMs);
    // What Discord's updater sends: PATCH /users/@me/settings-proto/<type>
    checkApiRequest(plugin, "PATCH", `/users/@me/settings-proto/${proto === "preloaded" ? 1 : 2}`);
    const updater = updaters[proto]();
    if (!updater) return "failed";

    let changed = false;
    const { promise: outcome, resolve: settle } = Promise.withResolvers<Outcome>();
    const onSave = (action: FluxAction) => {
        const settings = isRecord(action.settings) ? action.settings : undefined;
        if (action.wasSaved && settings?.type === updater.type) settle("saved");
    };
    Dispatcher.subscribe("USER_SETTINGS_PROTO_UPDATE", onSave);
    const timer = setTimeout(() => settle("timedOut"), timeoutMs);
    try {
        await updater.updateAsync(group, value => (changed = change(value) !== false), SAVE_NOW, () => settle("refused"));
        if (!changed) return "unchanged";
        const ended = await outcome;
        if (ended === "saved") return "saved";
        if (ended === "timedOut") return "failed";
    } catch (err) {
        // Logged, not reported: Discord and Evi read an uncaught error as a crash
        console.error(`${fn}:`, err);
    } finally {
        clearTimeout(timer);
        Dispatcher.unsubscribe("USER_SETTINGS_PROTO_UPDATE", onSave);
    }
    await updater.loadIfNecessary?.(true).catch(err => console.error(`${fn}: reloading Discord's settings failed:`, err));
    return "failed";
}

/** A custom status: text, an emoji, or both. `expiresAt` is in ms since 1970; left out, it doesn't expire. */
export interface CustomStatus {
    text: string;
    emojiName?: string;
    /** A custom emoji's id; left out for a Unicode emoji in `emojiName` */
    emojiId?: string;
    expiresAt?: number;
}

interface StoredCustomStatus { text?: unknown; emojiName?: unknown; emojiId?: unknown; expiresAtMs?: unknown; }

function storedStatus(): StoredCustomStatus | undefined {
    const raw = store<{ settings?: { status?: { customStatus?: unknown; }; }; }>("UserSettingsProtoStore")?.settings?.status?.customStatus;
    return isRecord(raw) ? raw : undefined;
}

/** A custom emoji's id: not "0", which Discord stores for none, nor one with a leading 0, which reads back different */
const isEmojiId = (value: unknown): value is string => snowflake.is(value) && !value.startsWith("0");

/** Discord's stored custom status in the shape plugins use; null for none. "0" ids and expiries are Discord's "none". */
function parseStatus(raw: StoredCustomStatus | undefined): CustomStatus | null {
    if (!raw) return null;
    const text = typeof raw.text === "string" ? raw.text : "";
    const emojiName = typeof raw.emojiName === "string" && raw.emojiName ? raw.emojiName : undefined;
    if (!text && !emojiName) return null;
    const storedId = typeof raw.emojiId === "bigint" ? String(raw.emojiId) : raw.emojiId;
    const emojiId = isEmojiId(storedId) ? storedId : undefined;
    const expiresAt = Number(raw.expiresAtMs);
    return { text, ...emojiName && { emojiName }, ...emojiId && { emojiId }, ...expiresAt > 0 && { expiresAt } };
}

const sameStatus = (a: CustomStatus | null, b: CustomStatus | null) =>
    a === b || (!!a && !!b && a.text === b.text && a.emojiName === b.emojiName && a.emojiId === b.emojiId && a.expiresAt === b.expiresAt);

function checkStatus(status: CustomStatus | null) {
    if (status === null) return;
    if (!isRecord(status) || typeof status.text !== "string" || status.text.length > 128) throw new TypeError("status.set: a custom status has text of at most 128 characters");
    if (status.emojiName !== undefined && typeof status.emojiName !== "string") throw new TypeError("status.set: emojiName must be a string");
    if (status.emojiId !== undefined && !isEmojiId(status.emojiId)) throw new TypeError(`status.set: emojiId must be a custom emoji's Discord id, got ${shownValue(status.emojiId)}`);
    if (status.expiresAt !== undefined && !(Number.isFinite(status.expiresAt) && status.expiresAt > 0)) throw new TypeError("status.set: expiresAt must be a time in ms since 1970");
    if (!status.text && !status.emojiName) throw new TypeError("status.set: a custom status has text, an emoji, or both; pass null to clear it");
}

/** The custom status, read from Discord's settings store and written through `updateSettings` */
export const customStatus = {
    get: (): CustomStatus | null => parseStatus(storedStatus()),

    /** Sets the custom status, or clears it with null, through `updateSettings` */
    async set(plugin: string, status: CustomStatus | null, options?: UpdateOptions): Promise<SaveResult> {
        checkStatus(status);
        const wanted = status && { text: status.text, ...status.emojiName && { emojiName: status.emojiName }, ...status.emojiId && { emojiId: status.emojiId }, ...status.expiresAt && { expiresAt: status.expiresAt } };
        const type = fieldType("preloaded", "status", "customStatus");
        return updateSettings<{ customStatus?: unknown; }>(plugin, "preloaded", "status", value => {
            if (sameStatus(parseStatus(isRecord(value.customStatus) ? value.customStatus : undefined), wanted)) return false;
            if (!wanted) {
                value.customStatus = undefined;
                return;
            }
            const stored = {
                text: wanted.text,
                emojiId: wanted.emojiId ?? "0",
                emojiName: wanted.emojiName ?? "",
                expiresAtMs: String(wanted.expiresAt ?? 0),
                createdAtMs: String(Date.now()),
            };
            value.customStatus = type?.create?.(stored) ?? stored;
        }, options, "status.set");
    },
};
