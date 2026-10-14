// @vitest-environment node
/**
 * The package ships an ESM and a CommonJS build. An application whose
 * dependencies load both gets two copies of every error class, and with a
 * plain prototype check an error thrown by one copy fails `instanceof`
 * against the other: `catch (e) { if (e instanceof NotFoundError) ... }`
 * silently stops matching. The classes brand their instances under a
 * `Symbol.for` key instead; this builds both formats from the real tsup
 * config, throws from one and catches with the other, both ways round.
 *
 * Built here rather than read from dist/, because the gate runs the tests
 * before the build and dist/ may be stale or absent.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Options } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type * as SDKModule from "../src/index.js";
import config from "../tsup.config";

type SDK = typeof SDKModule;

let outDir = "";
let esm: SDK;
let cjs: SDK;

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "billkit-node-dual-"));
  await build({
    ...(config as Options),
    entry: [join(__dirname, "..", "src", "index.ts")],
    outDir,
    dts: false,
    sourcemap: false,
    silent: true,
  });
  esm = (await import(pathToFileURL(join(outDir, "index.js")).href)) as SDK;
  cjs = createRequire(import.meta.url)(join(outDir, "index.cjs")) as SDK;
}, 60_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

function notFoundFetch(): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ error: { type: "not_found_error", message: "nope" } }), {
      status: 404,
    });
}

async function thrownBy(sdk: SDK): Promise<unknown> {
  const client = new sdk.BillKit({
    apiKey: "bk_test_unit",
    baseUrl: "https://test.billkit.eu",
    fetch: notFoundFetch(),
  });
  return client.customers.retrieve("cus_missing").catch((e: unknown) => e);
}

describe("instanceof across the ESM and CommonJS builds", () => {
  it("really is two copies of the classes", () => {
    expect(esm.NotFoundError).not.toBe(cjs.NotFoundError);
  });

  it.each([
    ["thrown by CommonJS, caught by ESM", () => cjs, () => esm],
    ["thrown by ESM, caught by CommonJS", () => esm, () => cjs],
  ])("%s", async (_label, thrower, catcher) => {
    const err = await thrownBy(thrower());
    const other = catcher();
    expect(err instanceof other.NotFoundError).toBe(true);
    expect(err instanceof other.APIError).toBe(true);
    expect(err instanceof other.BillKitError).toBe(true);
    expect(err instanceof other.ConflictError).toBe(false);
    expect(err instanceof other.APIConnectionError).toBe(false);
    expect((err as Error).name).toBe("NotFoundError");
  });

  it("brands errors raised outside a request too", () => {
    const err = new cjs.WebhookVerificationError("bad signature");
    expect(err instanceof esm.WebhookVerificationError).toBe(true);
    expect(err instanceof esm.BillKitError).toBe(true);
    expect(err instanceof esm.APIError).toBe(false);
  });
});
