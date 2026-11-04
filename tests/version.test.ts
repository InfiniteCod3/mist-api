import { expect, test } from "bun:test";

import pkg from "../package.json" with { type: "json" };
import { MIST_VERSION } from "../src/index";

test("MIST_VERSION is the version in package.json, so the CLI names the copy that was published", () => {
    expect(MIST_VERSION).toBe(pkg.version);
});
