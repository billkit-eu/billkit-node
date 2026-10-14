/**
 * The generated types are a function of the public OpenAPI spec, and this is
 * the check that they still are: regenerate in memory and compare with what
 * is committed. A spec change that nobody regenerated for fails here, before
 * the SDK can ship types that disagree with the API.
 *
 * The spec lives in the monorepo (`docs-public/public/openapi/latest.json`).
 * The public mirror of this package does not carry it, so there the suite
 * reports itself skipped rather than passing vacuously.
 */

import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error: a plain .mjs script with no type declarations.
import * as generator from "../scripts/generate-types.mjs";

const { DEFAULT_SPEC_PATH, OUTPUT_FILES, generate, loadSpec } = generator as {
  DEFAULT_SPEC_PATH: string;
  OUTPUT_FILES: Record<"models" | "requests", string>;
  generate: (spec: unknown) => Record<"models" | "requests", string>;
  loadSpec: (path?: string) => Record<string, unknown>;
};

describe.skipIf(!existsSync(DEFAULT_SPEC_PATH))("generated types", () => {
  // vitest runs a describe body at collection even when skipIf is true, so
  // the spec is only read once a test in here is actually going to run.
  // Reading it in the body failed the whole suite with ENOENT in the mirror.
  let output: Record<"models" | "requests", string>;
  beforeAll(() => {
    output = generate(loadSpec());
  });

  it.each(["models", "requests"] as const)("%s.ts matches the spec", (key) => {
    // On failure: run `npm run generate` and commit the result.
    expect(readFileSync(OUTPUT_FILES[key], "utf8")).toBe(output[key]);
  });

  it("notices a change to the spec", () => {
    const spec = loadSpec() as {
      components: { schemas: Record<string, { properties: Record<string, unknown> }> };
    };
    spec.components.schemas["CustomerResponse"]!.properties["loyalty_tier"] = { type: "string" };
    expect(generate(spec).models).not.toBe(output.models);
  });

  it("types every server-sent enum as open", () => {
    expect(output.models).toContain(
      'status: "incomplete" | "trialing" | "active" | "past_due" | "canceled" | (string & {});',
    );
    expect(output.models).not.toMatch(/: "[a-z_]+" \| "[a-z_]+";\n/);
  });

  it("names every webhook event in the union", () => {
    const spec = loadSpec() as { webhooks: Record<string, unknown> };
    for (const type of Object.keys(spec.webhooks)) {
      expect(output.models).toContain(`  ${JSON.stringify(type)}: `);
    }
  });
});
