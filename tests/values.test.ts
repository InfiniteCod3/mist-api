import { expect, test } from "bun:test";

import { describe, MASKED, secretTest, snapshot } from "../src/values";

test("masks fields named like secrets, at any depth", () => {
    const shot = snapshot({ user: "a", accessToken: "abc", nested: { password: "p", list: [{ cookie: "c" }] } });
    expect(shot).toEqual({ user: "a", accessToken: MASKED, nested: { password: MASKED, list: [{ cookie: MASKED }] } });
});

test("masks Map entries by key, like object fields", () => {
    const shot = snapshot(new Map<unknown, unknown>([["token", "x"], ["name", "y"], [1, "z"], ["licenseKey", "k"]]), secretTest(["licenseKey"]));
    expect(shot).toEqual([["token", MASKED], ["name", "y"], [1, "z"], ["licenseKey", MASKED]]);
});

test("a bare string can't be recognized as a secret", () => {
    expect(snapshot(["token-like-but-bare"])).toEqual(["token-like-but-bare"]);
});

test("masks the plugin's own secret names", () => {
    expect(snapshot({ license: "k", other: "v" }, secretTest(["license"]))).toEqual({ license: MASKED, other: "v" });
});

test("copies at record time and bounds what it keeps", () => {
    const value = { list: Array.from({ length: 60 }, (_, i) => i), text: "x".repeat(2500) };
    const shot = snapshot(value) as { list: unknown[]; text: string; };
    value.list.length = 0;
    expect(shot.list).toHaveLength(51);
    expect(shot.list[50]).toBe("…(+10 items)");
    expect(shot.text.length).toBeLessThan(2100);
});

test("survives cycles", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(snapshot(a)).toEqual({ name: "a", self: "[circular]" });
});

test("the redacted view says only type and size", () => {
    expect<string>(describe("secret words")).toBe("string(12)");
    expect<string>(describe([1, 2])).toBe("array(2)");
    expect<string>(describe({ a: 1 })).toBe("object(1 keys)");
    expect<string>(describe(4)).toBe("number");
});

test("token counts are shown: a field ending in tokens whose value is a number isn't a secret", () => {
    const usage = { input_tokens: 1200, output_tokens: 87, cache_read_input_tokens: 0, maxTokens: 4096 };
    expect(snapshot({ usage })).toEqual({ usage });
    expect(snapshot({ tokens: ["abc"], refresh_tokens: "def", token: 12, accessTokens: { a: "x" } }))
        .toEqual({ tokens: MASKED, refresh_tokens: MASKED, token: MASKED, accessTokens: MASKED });
});

test("the built-in names mask strings and numbers alike", () => {
    const names = ["token", "accessToken", "password", "cookie", "authorization", "apiKey", "sessionId", "clientSecret"];
    for (const value of ["v", 42]) {
        const shot = snapshot(Object.fromEntries(names.map(n => [n, value]))) as Record<string, unknown>;
        expect(Object.values(shot).every(v => v === MASKED)).toBe(true);
    }
});

test("a plugin's keys named <service>Token are masked with no secrets option, such as weatherToken", () => {
    expect(snapshot({ keys: { weatherToken: "w-123", mapsToken: "m-456", weather: "open" } }))
        .toEqual({ keys: { weatherToken: MASKED, mapsToken: MASKED, weather: "open" } });
});

test("reveal shows named fields the built-in names would mask, but never the plugin's own secrets", () => {
    const isSecret = secretTest(["licenseKey"], ["sessionId", "licenseKey"]);
    expect(snapshot({ sessionId: "4f7c", session_id: "x", licenseKey: "k", token: "t" }, isSecret))
        .toEqual({ sessionId: "4f7c", session_id: MASKED, licenseKey: MASKED, token: MASKED });
    expect(snapshot(new Map([["SESSIONID", "4f7c"]]), isSecret)).toEqual([["SESSIONID", "4f7c"]]);
});
