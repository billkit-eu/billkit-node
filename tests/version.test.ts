import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version.js";

/**
 * The version is written down twice: `package.json` is what npm publishes, and
 * `src/version.ts` is what the SDK reports in its User-Agent. Nothing derives
 * one from the other, because a browser-targeting dual ESM/CJS build has no
 * clean way to read the manifest at runtime.
 *
 * The release gate only checks the tag against `package.json`, so without this
 * test a bump that misses `src/version.ts` publishes cleanly and then reports
 * the wrong version on every request for the life of the release. That is the
 * kind of thing you discover from a support ticket, not from CI.
 */
describe("version", () => {
  it("matches the version in package.json", () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { version: string };

    expect(VERSION).toBe(manifest.version);
  });
});
