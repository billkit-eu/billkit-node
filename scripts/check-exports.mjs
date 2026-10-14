#!/usr/bin/env node
/**
 * Pack the package, unpack the tarball, and check that every value the
 * published declarations promise is really exported at runtime, through
 * both halves of the `exports` map (ESM `import` and CommonJS `require`).
 *
 *   node scripts/check-exports.mjs     # after `npm run build`
 *
 * Why it exists: the declaration bundler once dropped the `type` modifier
 * from `export type { Customers, ... }`. The bundled `index.d.ts` then
 * declared twenty classes as values, so `import { Customers }` type-checked
 * under `verbatimModuleSyntax` and failed at runtime, and `x instanceof
 * Customers` was `instanceof undefined` under CommonJS. Neither publint nor
 * arethetypeswrong compares the declared value exports with the runtime
 * ones, so this does, over the same tarball `npm publish` would upload.
 *
 * A name counts as a value export when TypeScript resolves it to a value
 * (a class, function, const or enum) and nothing on its alias chain is
 * type-only. Type-only exports are skipped: they have no runtime binding by
 * design.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function isTypeOnlyAlias(declaration) {
  if (ts.isExportSpecifier(declaration) || ts.isImportSpecifier(declaration)) {
    if (declaration.isTypeOnly) return true;
    // `export type { A, B }`: the modifier sits on the declaration.
    const clause = declaration.parent.parent;
    return Boolean(clause.isTypeOnly);
  }
  if (ts.isImportClause(declaration)) return declaration.isTypeOnly;
  if (ts.isNamespaceExport(declaration) || ts.isExportDeclaration(declaration)) {
    return Boolean((ts.isNamespaceExport(declaration) ? declaration.parent : declaration).isTypeOnly);
  }
  return false;
}

/** The names `file` exports as runtime values, according to TypeScript. */
export function declaredValueExports(file) {
  const program = ts.createProgram([file], {
    noEmit: true,
    skipLibCheck: true,
    types: [],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`TypeScript could not load ${file}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`${file} is not a module`);

  const names = [];
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    let symbol = exported;
    let typeOnly = false;
    // Walk the alias chain one hop at a time so a `type` modifier anywhere
    // on it (an `export type { X }` re-exporting a plain `export { X }`)
    // marks the name type-only, as it does for a consumer.
    for (let hop = 0; hop < 32 && symbol.flags & ts.SymbolFlags.Alias; hop++) {
      if ((symbol.declarations ?? []).some(isTypeOnlyAlias)) typeOnly = true;
      symbol = checker.getImmediateAliasedSymbol(symbol) ?? checker.getAliasedSymbol(symbol);
    }
    if (typeOnly) continue;
    if (symbol.flags & ts.SymbolFlags.Value) names.push(exported.name);
  }
  return names.sort();
}

function missingAtRuntime(declared, runtime) {
  return declared.filter((name) => !(name in runtime) || runtime[name] === undefined);
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), "billkit-node-exports-"));
  try {
    const packed = execFileSync("npm", ["pack", "--json", "--pack-destination", work], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      // Under `npm publish --dry-run` npm exports npm_config_dry_run=true to
      // prepublishOnly, which would make this pack write no tarball at all.
      env: { ...process.env, npm_config_dry_run: "false" },
    });
    const [{ filename }] = JSON.parse(packed);
    execFileSync("tar", ["-xzf", join(work, filename), "-C", work]);
    const pkgDir = join(work, "package");
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    const entry = manifest.exports["."];

    const failures = [];
    const conditions = [
      {
        label: "ESM (import)",
        types: entry.import.types,
        load: async (path) => import(pathToFileURL(path).href),
        runtime: entry.import.default,
      },
      {
        label: "CommonJS (require)",
        types: entry.require.types,
        load: async (path) => createRequire(import.meta.url)(path),
        runtime: entry.require.default,
      },
    ];
    for (const condition of conditions) {
      const declared = declaredValueExports(join(pkgDir, condition.types));
      // A parse that found nothing would pass vacuously; the client class is
      // the one export that can never legitimately disappear.
      if (!declared.includes("BillKit")) {
        failures.push(`${condition.label}: ${condition.types} declares no BillKit value export`);
        continue;
      }
      const runtime = await condition.load(join(pkgDir, condition.runtime));
      const missing = missingAtRuntime(declared, runtime);
      if (missing.length > 0) {
        failures.push(
          `${condition.label}: ${condition.types} declares ${missing.length} value export(s) ` +
            `that ${condition.runtime} does not have: ${missing.join(", ")}`,
        );
      } else {
        process.stdout.write(
          `${condition.label}: all ${declared.length} declared value exports exist at runtime\n`,
        );
      }
    }
    if (failures.length > 0) {
      process.stderr.write(`${failures.join("\n")}\n`);
      process.exitCode = 1;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
