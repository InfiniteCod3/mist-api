/**
 * Holds what a plugin does through mist (Discord's API from /discord, message UI and send hooks from
 * /ui) to the `permissions` in its manifest, by the rules Evi holds the plugin's fetch and hooks to.
 * Evi can't see what goes through Discord's client or mist's patches: without this, mist would be a
 * way around a plugin's declaration.
 *
 * The rules are copied from Evi's src/shared/declaredPermissions.ts (isHost, readPermissions,
 * hostAllowed, DISCORD_WRITES, apiPath, PluginPermissionError): plugin code can't import Evi's
 * shared code. They must change when Evi's do.
 */
import { attempt, shownValue } from "./internal.ts";
import { eviOf, registry } from "./registry.ts";
import { isRecord } from "./util.ts";

export type PermissionFlag = "readMessages" | "sendMessages" | "changeSettings";
export type PermissionKey = "network" | PermissionFlag;

interface DeclaredPermissions {
    network: string[];
    readMessages: boolean;
    sendMessages: boolean;
    changeSettings: boolean;
}

const LABEL = String.raw`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`;
const HOST_RE = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})+|localhost)$`, "i");
const isHost = (value: unknown): value is string => typeof value === "string" && value.length <= 253 && HOST_RE.test(value);

/** Undefined when the manifest doesn't declare: Evi holds such a plugin to nothing */
function readPermissions(raw: unknown): DeclaredPermissions | undefined {
    if (!isRecord(raw)) return undefined;
    const hosts = Array.isArray(raw.network) ? raw.network.filter(isHost).map(h => h.toLowerCase()) : [];
    return {
        network: [...new Set(hosts)].sort().slice(0, 50),
        readMessages: raw.readMessages === true,
        sendMessages: raw.sendMessages === true,
        changeSettings: raw.changeSettings === true,
    };
}

function hostAllowed(declared: DeclaredPermissions, host: string) {
    const bare = host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
    return declared.network.some(h => bare === h || bare.endsWith(`.${h}`));
}

const DISCORD_WRITES: [PermissionFlag, RegExp][] = [
    ["sendMessages", /^\/(?:channels\/\d+\/(?:messages|threads)(?:\/|$)|interactions$|webhooks\/\d+\/[^/]+)/i],
    ["changeSettings", /^\/users\/@me(?:\/(?:settings(?:-proto\/\d+)?|guilds\/\d+\/settings|profile|consent|connections(?:\/.*)?))?$/i],
];

export function apiPath(pathname: string) {
    let path: string;
    try {
        path = decodeURIComponent(pathname);
    } catch {
        return undefined;
    }
    return path.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1").replace(/^\/api(?:\/v\d+)?(?=\/)/i, "");
}

const PERMISSION_WORDS: Record<PermissionKey, string> = {
    network: "contact",
    readMessages: "read messages",
    sendMessages: "send messages",
    changeSettings: "change settings",
};

/** What mist throws, before anything is sent, for a request the plugin's manifest doesn't declare */
export class PluginPermissionError extends Error {
    override name = "PluginPermissionError";

    constructor(readonly plugin: string, readonly permission: PermissionKey, readonly target: string) {
        super(permission === "network"
            ? `${plugin} can't contact ${target}: its manifest doesn't list it in permissions.network`
            : `${plugin} can't ${PERMISSION_WORDS[permission]} (${target}): its manifest doesn't declare permissions.${permission}`);
    }
}

const API_HOST = "discord.com";

/**
 * `path` as Discord's API reads it: Discord's client puts its API endpoint (/api/v9) in front, and
 * the URL parser resolves dot segments. Undefined for a path that can't be read or that climbs out
 * of /api, which could be any path.
 */
export function readApiPath(path: string): string | undefined {
    let pathname: string;
    try {
        pathname = new URL(`https://${API_HOST}/api/v9${path}`).pathname;
    } catch {
        return undefined;
    }
    if (!pathname.startsWith("/api/")) return undefined;
    return apiPath(pathname);
}

/** A "." or ".." segment, plain or escaped: the URL parser resolves it, so it can climb to another route */
const DOT_SEGMENT = /(?:^|[/\\])(?:\.|%2e){1,2}(?=[/\\]|$)/i;

/** Raw ASCII control characters: the URL parser strips tab, CR and LF before resolving "/" or ".." */
const CONTROL_CHAR = /[\x00-\x1f\x7f]/;

function hasDotSegment(path: string) {
    const route = path.split(/[?#]/, 1)[0];
    if (DOT_SEGMENT.test(route)) return true;
    try {
        return DOT_SEGMENT.test(decodeURIComponent(route));
    } catch {
        return false;
    }
}

/**
 * Throws a TypeError, starting with `fn`, unless `path` is a path on Discord's origin: one leading
 * "/", no second "/" or "\" after it that would make it a host, no raw control characters, and no
 * "." or ".." segment, plain or escaped, that would climb to another route. Discord's client signs
 * any URL it gets, and an absolute one would carry the login elsewhere.
 */
export function assertAppPath(fn: string, path: unknown, what: string): asserts path is string {
    if (typeof path !== "string" || !/^\/(?![/\\])/.test(path)) throw new TypeError(`${fn}: ${what} must start with a single "/", got ${shownValue(path)}`);
    if (CONTROL_CHAR.test(path)) throw new TypeError(`${fn}: ${what} can't contain control characters, got ${shownValue(path)}`);
    if (hasDotSegment(path)) throw new TypeError(`${fn}: ${what} can't have a "." or ".." segment, got ${shownValue(path)}`);
}

/** Thrown for an id Evi has no plugin by: without this, any made-up id would count as a plugin that declares nothing */
export class UnknownPluginError extends Error {
    override name = "UnknownPluginError";

    constructor(readonly plugin: string) {
        super(`${plugin} isn't a plugin Evi has loaded`);
    }
}

// Read at each request, not kept: an update can change the declaration while the page stays open
function declaredBy(plugin: string) {
    const installed = eviOf()?.plugins?.get(plugin);
    if (!installed) throw new UnknownPluginError(plugin);
    return readPermissions(installed.manifest?.permissions);
}

/** Throws unless the plugin's manifest covers `method` on `path` (a path on Discord's API) */
export function checkApiRequest(plugin: string, method: string, path: string) {
    const declared = declaredBy(plugin);
    if (!declared) return;
    if (!hostAllowed(declared, API_HOST)) throw new PluginPermissionError(plugin, "network", API_HOST);
    if (/^(?:GET|HEAD|OPTIONS)$/i.test(method)) return;
    const read = readApiPath(path);
    for (const [permission, re] of DISCORD_WRITES) {
        // A path that can't be read could be any of them
        if ((read === undefined || re.test(read)) && !declared[permission]) throw new PluginPermissionError(plugin, permission, API_HOST);
    }
}

/** Throws unless the plugin's manifest declares `permission` (or declares nothing) */
export function need(plugin: string, permission: PermissionFlag, target: string) {
    const declared = declaredBy(plugin);
    if (declared && !declared[permission]) throw new PluginPermissionError(plugin, permission, target);
}

/** The mist objects this copy of mist-api made, with the id each was made for */
const made = new WeakMap<object, string>();

/** Called by createMist with each mist object it makes */
export function claimMist(mist: object, id: string) {
    made.set(mist, id);
}

/**
 * The id of `mist`, which must be a mist object from createMist: one this copy made, or one whose
 * handle mist's page registry holds for its id (a mist from another bundled copy). A string or a
 * look-alike `{ id }` is refused.
 *
 * These checks hold a plugin to its manifest's declarations: a plugin can't reach Discord's API
 * through mist beyond what it declared. They aren't a wall between adversarial plugins, since code
 * on one page can reach anything else on it.
 */
export function pluginOf(mist: unknown, usage: string): string {
    const known = isRecord(mist) ? made.get(mist) : undefined;
    if (known !== undefined) return known;
    const id = isRecord(mist) ? mist.id : undefined;
    const refuse = () => new TypeError(`${usage} takes the mist object from createMist; got ${shownValue(mist)}${typeof id === "string" ? ` with id ${shownValue(id)}` : ""}`);
    if (typeof id !== "string" || !id) throw refuse();
    const owns = attempt(() => registry().get(id)?.owns?.(mist) === true);
    if (!owns.ok) throw new TypeError(`${usage}: mist's page registry threw checking ${id}: ${owns.error}`);
    if (!owns.value) throw refuse();
    return id;
}
