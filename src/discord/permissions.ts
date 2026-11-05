/**
 * Holds requests a plugin makes through mist to the `permissions` in its manifest, by the rules Evi
 * holds the plugin's own fetch to. Evi can't see requests that go through Discord's own client, so
 * without this mist would be a way around a plugin's declaration.
 *
 * The rules are copied from Evi's src/shared/declaredPermissions.ts (isHost, readPermissions,
 * hostAllowed, DISCORD_WRITES, apiPath, PluginPermissionError), because plugin code can't import
 * Evi's shared code. They must change when Evi's do.
 */
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
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const p = raw as Record<string, unknown>;
    const hosts = Array.isArray(p.network) ? p.network.filter(isHost).map(h => h.toLowerCase()) : [];
    return {
        network: [...new Set(hosts)].sort().slice(0, 50),
        readMessages: p.readMessages === true,
        sendMessages: p.sendMessages === true,
        changeSettings: p.changeSettings === true,
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

function apiPath(pathname: string) {
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

interface EviPlugins {
    plugins?: { get(id: string): { manifest?: { permissions?: unknown; }; } | undefined; };
}

/** Thrown for an id Evi has no plugin by: without this, any made-up id would count as a plugin that declares nothing */
export class UnknownPluginError extends Error {
    override name = "UnknownPluginError";

    constructor(readonly plugin: string) {
        super(`${plugin} isn't a plugin Evi has loaded: pass discord() the plugin's own mist object or id`);
    }
}

// Read at each request, not kept: an update can change the declaration while the page stays open
function declaredBy(plugin: string) {
    const installed = (globalThis as { Evi?: EviPlugins; }).Evi?.plugins?.get(plugin);
    if (!installed) throw new UnknownPluginError(plugin);
    return readPermissions(installed.manifest?.permissions);
}

/** Throws unless the plugin's manifest covers `method` on `path` (a path on Discord's API) */
export function checkApiRequest(plugin: string, method: string, path: string) {
    const declared = declaredBy(plugin);
    if (!declared) return;
    if (!hostAllowed(declared, API_HOST)) throw new PluginPermissionError(plugin, "network", API_HOST);
    if (/^(?:GET|HEAD|OPTIONS)$/i.test(method)) return;
    // Discord's client puts its API endpoint in front of the path, so read it as that URL would be
    const read = apiPath(new URL(`https://${API_HOST}/api${path}`).pathname);
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
