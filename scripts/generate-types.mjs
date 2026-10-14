#!/usr/bin/env node
/**
 * Generate the SDK's response and request types from the public OpenAPI spec.
 *
 *   node scripts/generate-types.mjs            # rewrite src/generated/*.ts
 *   node scripts/generate-types.mjs --check    # exit 1 if they would change
 *   node scripts/generate-types.mjs --spec path/to/openapi.json
 *
 * The spec is `docs-public/public/openapi/latest.json` in the monorepo: the
 * same document the public docs site serves, so the types a caller gets are
 * the contract the API publishes. `tests/generated.test.ts` runs this in
 * memory and fails when the committed output differs, which is what stops
 * the SDK drifting from the API.
 *
 * Deliberately a small script with no dependencies rather than a general
 * OpenAPI generator. The spec uses a narrow slice of JSON Schema (`type`,
 * `anyOf`, `$ref`, `const`, `enum`, `x-extensible-enum`, `properties`,
 * `required`, `items`, `additionalProperties`), and the two decisions that
 * matter here are ours to make, not a generator's defaults:
 *
 * - An `x-extensible-enum` on a response is an OPEN enum: the API can add a
 *   value without a new SDK, so it becomes `"a" | "b" | (string & {})`.
 *   Editors still autocomplete the known values, and an unknown one is not
 *   a type error at the place it arrives.
 * - Response schemas lose their `Response` suffix (`CustomerResponse` is
 *   `Customer`) and `ListResponse_X_` becomes the generic `ListResponse<X>`,
 *   so the names read like the objects the docs talk about.
 *
 * Two files come out. `models.ts` holds every schema a response or a
 * webhook can carry, and is public. `requests.ts` holds the request bodies,
 * and is internal: the hand-written `*Params` interfaces carry far better
 * documentation, and `src/specConformance.ts` checks their key sets against
 * these at compile time instead.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(HERE, "..");
export const DEFAULT_SPEC_PATH = resolve(
  PACKAGE_ROOT,
  "..",
  "..",
  "docs-public",
  "public",
  "openapi",
  "latest.json",
);
export const OUTPUT_FILES = {
  models: join(PACKAGE_ROOT, "src", "generated", "models.ts"),
  requests: join(PACKAGE_ROOT, "src", "generated", "requests.ts"),
};

const REF_PREFIX = "#/components/schemas/";
const LIST_RE = /^ListResponse_(.+)_$/;

/** Response names that read badly with the suffix simply dropped. */
const RENAMES = {
  Error: "APIErrorBody",
  ErrorDetail: "APIErrorDetail",
  CouponValidateResponse: "CouponValidation",
  InvoiceEmailResponse: "InvoiceEmailResult",
  BillingPortalSessionRevokeResponse: "BillingPortalSessionRevocation",
  "PortalTenantTheme-Output": "PortalTenantTheme",
  "PortalTenantTheme-Input": "PortalTenantThemeInput",
};

export function typeName(schemaName) {
  if (Object.hasOwn(RENAMES, schemaName)) return RENAMES[schemaName];
  if (schemaName.endsWith("Response") && schemaName !== "Response") {
    return schemaName.slice(0, -"Response".length);
  }
  return schemaName.replace(/[^A-Za-z0-9_]/g, "");
}

function refName(ref) {
  if (!ref.startsWith(REF_PREFIX)) throw new Error(`Unsupported $ref: ${ref}`);
  return ref.slice(REF_PREFIX.length);
}

/** Resolve a local JSON pointer (`#/components/headers/X`) in the spec. */
function resolvePointer(spec, ref) {
  if (!ref.startsWith("#/")) throw new Error(`Unsupported $ref: ${ref}`);
  let node = spec;
  for (const part of ref.slice(2).split("/")) {
    node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  if (node === undefined) throw new Error(`Dangling $ref: ${ref}`);
  return node;
}

/**
 * Every schema name reachable from `roots`, following `$ref`s. Refs into
 * other component sections (shared response headers, say) are followed
 * too, since a schema can hang off them.
 */
function reachable(spec, roots) {
  const schemas = spec.components?.schemas ?? {};
  const seen = new Set();
  const followed = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node === null || typeof node !== "object") return;
    if (typeof node.$ref === "string") {
      if (node.$ref.startsWith(REF_PREFIX)) {
        const name = refName(node.$ref);
        if (!seen.has(name)) {
          seen.add(name);
          visit(schemas[name]);
        }
      } else if (!followed.has(node.$ref)) {
        followed.add(node.$ref);
        visit(resolvePointer(spec, node.$ref));
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(roots);
  return seen;
}

function responseRoots(spec) {
  const roots = [];
  for (const item of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(item)) {
      if (op && typeof op === "object" && op.responses) roots.push(op.responses);
    }
  }
  roots.push(spec.webhooks ?? {});
  return roots;
}

function requestRoots(spec) {
  const roots = [];
  for (const item of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(item)) {
      if (op && typeof op === "object" && op.requestBody) roots.push(op.requestBody);
    }
  }
  return roots;
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propKey(key) {
  return IDENT_RE.test(key) ? key : JSON.stringify(key);
}

function literal(value) {
  return JSON.stringify(value);
}

function docComment(text, indent) {
  if (!text) return "";
  const clean = String(text)
    .replace(/\*\//g, "*\\/")
    .replace(/``/g, "`")
    .trim();
  const lines = clean.split("\n").map((line) => line.trimEnd());
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((l) => (l ? `${indent} * ${l}` : `${indent} *`)).join("\n")}\n${indent} */\n`;
}

/**
 * `mode` is "model" or "request". The only difference: a closed `enum` on a
 * request stays closed (the API refuses anything else there), while any
 * enum on a model is open.
 */
function tsType(schema, mode, indent) {
  if (schema === true || schema === undefined || schema === null) return "unknown";
  if (schema.$ref) {
    const name = refName(schema.$ref);
    const list = LIST_RE.exec(name);
    if (list) return `ListResponse<${typeName(list[1])}>`;
    return typeName(name);
  }
  if (Array.isArray(schema.anyOf)) {
    const members = [];
    for (const member of schema.anyOf) {
      const t = tsType(member, mode, indent);
      if (!members.includes(t)) members.push(t);
    }
    return members.join(" | ");
  }
  if (Object.hasOwn(schema, "const")) return literal(schema.const);
  if (Array.isArray(schema["x-extensible-enum"])) {
    return [...schema["x-extensible-enum"].map(literal), "(string & {})"].join(" | ");
  }
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.map(literal);
    return mode === "model" ? [...values, "(string & {})"].join(" | ") : values.join(" | ");
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const item = tsType(schema.items, mode, indent);
      return /[ |&]/.test(item) ? `Array<${item}>` : `${item}[]`;
    }
    case "object":
    case undefined: {
      if (schema.properties && Object.keys(schema.properties).length > 0) {
        return objectLiteral(schema, mode, indent);
      }
      const extra = schema.additionalProperties;
      if (extra && typeof extra === "object") return `Record<string, ${tsType(extra, mode, indent)}>`;
      if (schema.type === "object" || extra === true) return "Record<string, unknown>";
      return "unknown";
    }
    default:
      throw new Error(`Unsupported schema type: ${JSON.stringify(schema.type)}`);
  }
}

/**
 * Whether a property is always present on the wire. On a response, a field
 * with a `const` and a `default` (pydantic's `deleted: Literal[True] = True`)
 * is serialised every time even though the schema leaves it out of
 * `required`, so typing it optional would make callers test for a value that
 * cannot be missing. A request keeps it optional: the caller may omit it.
 */
function isRequired(key, prop, required, mode) {
  if (required.has(key)) return true;
  return mode === "model" && "const" in prop && "default" in prop;
}

function objectBody(schema, mode, indent) {
  const required = new Set(schema.required ?? []);
  let out = "";
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    out += docComment(prop.description, `${indent}  `);
    const optional = isRequired(key, prop, required, mode) ? "" : "?";
    out += `${indent}  ${propKey(key)}${optional}: ${tsType(prop, mode, `${indent}  `)};\n`;
  }
  return out;
}

function objectLiteral(schema, mode, indent) {
  return `{\n${objectBody(schema, mode, indent)}${indent}}`;
}

/**
 * `DeletedResource` and `PurgedResource` are generic over their `object`.
 * The API answers every DELETE (and every purge) with one schema and an
 * untyped `object`, but each SDK method knows which kind it removed, so
 * `customers.delete()` can resolve to `DeletedResource<"customer">` rather
 * than a bare `string`.
 */
const MARKER_SCHEMAS = new Set(["DeletedResource", "PurgedResource"]);

function markerDeclaration(name, decl, schema) {
  if (schema.properties?.object?.type !== "string") {
    throw new Error(`${name}.object is no longer a plain string; revisit the generic.`);
  }
  const generic = decl
    .replace(
      `export interface ${name} {`,
      `export interface ${name}<TObject extends string = string> {`,
    )
    .replace("\n  object: string;\n", "\n  /** The kind of object removed, such as `\"customer\"`. */\n  object: TObject;\n");
  if (!generic.includes("object: TObject;") || !generic.includes("<TObject")) {
    throw new Error(`${name} did not take the expected shape; revisit the generic.`);
  }
  return generic;
}

function declaration(name, schema, mode) {
  if (MARKER_SCHEMAS.has(name) && mode === "model") {
    return markerDeclaration(name, plainDeclaration(name, schema, mode), schema);
  }
  return plainDeclaration(name, schema, mode);
}

function plainDeclaration(name, schema, mode) {
  const tsName = typeName(name);
  let out = docComment(schema.description, "");
  const isObject =
    (schema.type === "object" || schema.type === undefined) &&
    schema.properties &&
    Object.keys(schema.properties).length > 0;
  if (isObject) {
    out += `export interface ${tsName} {\n${objectBody(schema, mode, "")}}\n`;
  } else {
    out += `export type ${tsName} = ${tsType(schema, mode, "")};\n`;
  }
  return out;
}

function header(spec) {
  return (
    "// Generated by scripts/generate-types.mjs from the BillKit OpenAPI spec\n" +
    `// (info.version ${spec.info?.version ?? "unknown"}). Do not edit by hand: run\n` +
    "// `npm run generate`, and `npm test` fails if this file is stale.\n\n"
  );
}

/** Webhook event schemas, keyed by event type, in the spec's order. */
function webhookEvents(spec) {
  const events = [];
  for (const [eventType, item] of Object.entries(spec.webhooks ?? {})) {
    const ref = item?.post?.requestBody?.content?.["application/json"]?.schema?.$ref;
    if (typeof ref !== "string") throw new Error(`Webhook ${eventType} has no body schema`);
    events.push({ eventType, name: typeName(refName(ref)) });
  }
  return events;
}

function pascal(snake) {
  return snake
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

/**
 * One interface per operation that takes query parameters, named after its
 * `operationId` (`list_customers` is `ListCustomersQuery`), so the
 * hand-written list params can be checked against what the route binds.
 */
function queryInterfaces(spec) {
  let out = "";
  for (const item of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(item)) {
      if (!op || typeof op !== "object" || !op.operationId) continue;
      const query = (op.parameters ?? []).filter((param) => param.in === "query");
      if (query.length === 0) continue;
      const schema = {
        type: "object",
        properties: Object.fromEntries(
          query.map((param) => [param.name, { ...param.schema, description: param.description }]),
        ),
        required: query.filter((param) => param.required).map((param) => param.name),
      };
      out += `\n${declaration(`${pascal(op.operationId)}Query`, schema, "request")}`;
    }
  }
  return out;
}

export function generate(spec) {
  const schemas = spec.components?.schemas ?? {};
  const modelNames = reachable(spec, responseRoots(spec));
  const requestNames = [...reachable(spec, requestRoots(spec))].filter(
    (name) => !modelNames.has(name),
  );

  let models = header(spec);
  models +=
    "/**\n" +
    " * One page of a list endpoint. Pagination is forward-only: pass the last\n" +
    " * row's `id` as `starting_after` to fetch the next page while `has_more`.\n" +
    " */\n" +
    "export interface ListResponse<T> {\n" +
    '  object: "list";\n' +
    "  data: T[];\n" +
    "  has_more: boolean;\n" +
    "}\n";
  for (const name of Object.keys(schemas)) {
    if (!modelNames.has(name) || LIST_RE.test(name)) continue;
    models += `\n${declaration(name, schemas[name], "model")}`;
  }

  const events = webhookEvents(spec);
  models +=
    "\n/**\n" +
    " * Every event type this SDK version knows, mapped to the body BillKit\n" +
    " * delivers for it.\n" +
    " */\n" +
    "export interface WebhookEventMap {\n" +
    events.map((e) => `  ${literal(e.eventType)}: ${e.name};\n`).join("") +
    "}\n";
  models +=
    "\n/**\n" +
    " * A webhook delivery body of a type this SDK version knows, discriminated\n" +
    " * on `type`: once narrowed, `event.type === \"invoice.paid\"` types\n" +
    " * `event.data` as an `Invoice`.\n" +
    " *\n" +
    " * `verifyWebhookSignature` returns `WebhookEvent | UnknownWebhookEvent`,\n" +
    " * because a newer API can deliver a type this union does not name. Narrow\n" +
    " * with `isKnownEventType(event)` first. New types arrive in minor releases,\n" +
    " * so an exhaustive `never` check over `type` is not supported.\n" +
    " */\n" +
    "export type WebhookEvent = WebhookEventMap[keyof WebhookEventMap];\n" +
    "\n/**\n" +
    " * A webhook delivery whose `type` this SDK version does not know, usually\n" +
    " * because the API is newer. Acknowledge it with a 2xx and move on: a\n" +
    " * non-2xx only makes BillKit retry a delivery you will never process.\n" +
    " */\n" +
    "export interface UnknownWebhookEvent {\n" +
    "  /** When the event was recorded, Unix seconds. */\n" +
    "  created: number;\n" +
    "  /** The object the event is about. Untyped: this SDK version does not know its shape. */\n" +
    "  data: unknown;\n" +
    "  /** The `evt_` id. Deduplicate on it. */\n" +
    "  id: string;\n" +
    "  livemode: boolean;\n" +
    '  object: "event";\n' +
    "  /** On an update, the fields of `data` that changed, with their values before the change. */\n" +
    "  previous_attributes: Record<string, unknown> | null;\n" +
    "  type: string & {};\n" +
    "}\n";

  let requests = header(spec);
  const usedModels = new Set();
  let body = "";
  for (const name of Object.keys(schemas)) {
    if (!requestNames.includes(name)) continue;
    const decl = declaration(name, schemas[name], "request");
    for (const match of decl.matchAll(/\b([A-Z][A-Za-z0-9]*)\b/g)) {
      const candidate = match[1];
      for (const modelName of modelNames) {
        if (typeName(modelName) === candidate) usedModels.add(candidate);
      }
    }
    body += `\n${decl}`;
  }
  body += queryInterfaces(spec);
  if (usedModels.size > 0) {
    requests += `import type { ${[...usedModels].sort().join(", ")} } from "./models.js";\n`;
  }
  requests += body;

  return { models, requests };
}

export function loadSpec(path = DEFAULT_SPEC_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main(argv) {
  const check = argv.includes("--check");
  const specFlag = argv.indexOf("--spec");
  const specPath = specFlag >= 0 ? resolve(argv[specFlag + 1]) : DEFAULT_SPEC_PATH;
  if (check && specFlag < 0 && !existsSync(specPath)) {
    // The public mirror of this package does not carry the spec; the types
    // are generated, and checked, in the monorepo that does.
    process.stdout.write(`No spec at ${specPath}; the drift check runs in the monorepo.\n`);
    return;
  }
  const output = generate(loadSpec(specPath));
  const stale = [];
  for (const [key, file] of Object.entries(OUTPUT_FILES)) {
    let current = null;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      current = null;
    }
    if (current === output[key]) continue;
    if (check) {
      stale.push(file);
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, output[key]);
      process.stdout.write(`wrote ${file}\n`);
    }
  }
  if (check && stale.length > 0) {
    process.stderr.write(
      `Generated types are stale against ${specPath}:\n  ${stale.join("\n  ")}\n` +
        "Run `npm run generate` and commit the result.\n",
    );
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
