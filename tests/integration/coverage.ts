/**
 * Parity gate: assert this suite implements every scenario in the shared
 * manifest (`sdk/integration/scenarios.json`).
 *
 * This is what turns the parity matrix from documentation into a build
 * gate. Adding an entry to the manifest fails *every* SDK suite that has
 * not implemented it yet, so a capability can't land in one language and
 * quietly skip the others. The python and php suites carry the identical
 * check against the same file.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Manifest {
  version: number;
  families: Record<string, string[]>;
  scenarios: Array<{ id: string; family: string; group: string; summary: string }>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, "..", "..", "integration", "scenarios.json");

/**
 * The family this SDK belongs to. Only scenarios in the same family are
 * required of it: a browser checkout SDK has no `crud.product` to
 * implement, and a server API client has no iframe to mount.
 */
const FAMILY = "server";

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

/** Scenario ids this run actually exercised; populated by `scenario()`. */
export const COVERED = new Set<string>();

export function assertManifestCoverage(): void {
  const manifest = loadManifest();
  const required = manifest.scenarios.filter((s) => s.family === FAMILY).map((s) => s.id);
  const missing = required.filter((id) => !COVERED.has(id));
  const unknown = [...COVERED].filter((id) => !required.includes(id));

  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(
      `Not implemented by the node suite (family "${FAMILY}"):\n  ${missing.join("\n  ")}\n` +
        "Implement them, or drop them from sdk/integration/scenarios.json if the " +
        "capability is genuinely gone from every SDK.",
    );
  }
  if (unknown.length > 0) {
    problems.push(
      `Tagged with ids that are not in the manifest:\n  ${unknown.join("\n  ")}\n` +
        "Add them to sdk/integration/scenarios.json so python + php are held to " +
        "the same bar (that is the whole point of the manifest).",
    );
  }
  if (problems.length > 0) {
    throw new Error(`SDK integration parity gate failed.\n\n${problems.join("\n\n")}`);
  }
}
