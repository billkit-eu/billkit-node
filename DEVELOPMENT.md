# Developing `@billkit-eu/sdk`

For changing this package. If you are only *using* the SDK, read `AGENTS.md`.

This is the **reference implementation** the Python and PHP SDKs are ported
from. Change behaviour here first, then mirror it — with one standing exception
recorded in `../AGENTS.md`: python currently carries a surface node does not,
and reconciling that means adding it here, never removing it there.

- ESM + CJS via `tsup`. Runs on Node 20+, Bun, Deno, Cloudflare Workers, and the
  browser (Web Crypto only, no Node-specific deps).

## Layout (`src/`)

- `client.ts`: `BillKit` class; one field per resource; resolves `BILLKIT_API_KEY`.
- `transport.ts`: `fetch`-backed HTTP + retry + error mapping. `fetch` is
  injectable (tests, Workers). `DEFAULT_BASE_URL = https://api.billkit.eu`.
- `retry.ts`: policy + `backoffForMs`/`shouldRetry`.
- `pagination.ts`: `paginate()` async iterator (`iter()` on each resource).
- `errors.ts`: `BillKitError` + subclasses; `errorFromResponse` maps `type`/status.
- `webhooks.ts`: `verifyWebhookSignature` (HMAC-SHA256 via SubtleCrypto); must
  match `api/.../core/signing.py`.
- `resources.ts`: every resource family + its `*Params` interfaces.
- `logging.ts`: the opt-in `BillKitLogger` seam; default `NOOP_LOGGER`.
- `version.ts`: `VERSION`, and it is a release-gate file — see below.

## Conventions

- Ships **no runtime schemas**: calls return `unknown`; callers parameterise
  with their own generic (`client.customers.create<Customer>(...)`).
- Every mutating call auto-sends an `Idempotency-Key` (`sdk-<uuid>`); overridable.
- `undefined` params are pruned before serialisation; `false`/`0`/`""` kept.
- **A sub-minor-unit rate is typed `string` and a `number` is refused at
  runtime.** `assertDecimalRateIsString` / `assertPriceRatesAreStrings` in
  `resources.ts` guard `unit_amount_decimal` at the price level and inside every
  tier. The type stops TypeScript callers; the runtime check is for the ones it
  cannot reach (plain JS, a value through `any`, a parsed body). A double cannot
  hold 0.0002 exactly, so coercing would work for the rates that happen to
  round-trip and silently mis-price the ones that do not.
- **A method whose validation throws must be `async`.** `prices.create` is,
  for that reason: a synchronous throw out of a method typed `Promise<T>`
  escapes `.catch()`, so the caller would need try/catch *as well*, which nobody
  writes for a promise-returning API.

## Quality gates

```bash
npm ci
npm run typecheck   # tsc --strict, no emit
npm run lint        # eslint
npm test            # vitest; tests inject makeMockFetch (tests/helpers.ts)
npm run build       # tsup → dist/ (ESM+CJS+d.ts)
```

Release: bump `package.json` + `src/version.ts` + `CHANGELOG.md`, refresh
`package-lock.json`, tag `sdk-node-vX.Y.Z` (workflow gates tag == package.json).
`check_version_agreement()` in `../scripts/lib.sh` scans **every** version
declaration under the package, including two inside `package-lock.json`, so all
of them have to agree before a tag will publish.

## TypeScript 7 is BLOCKED upstream (do not bump yet)

`typescript` is dev-only (typecheck + `.d.ts` emit); a bump can't affect what
consumers install. But `6 → 7` is **not viable as of 2026-07**. TS 7 is the
native (Go) port with a new compiler API, and the build/lint tooling can't run
on it. Tried `typescript@7.0.2`: `typecheck` + `test` pass, but

- **`npm run build` fails.** tsup's `.d.ts` generator (`rollup-plugin-dts`,
  latest 6.4.1) peers `typescript: ^4.5 || ^5.0 || ^6.0`, so DTS emit throws
  (`useCaseSensitiveFileNames` undefined). No types → unpublishable
  (`prepublishOnly` runs `build`).
- **`npm run lint` fails.** `@typescript-eslint` (latest 8.65.0) peers
  `typescript: >=4.8.4 <6.1.0`; `typescript-estree` crashes on TS 7.

**`frontend/` is already on `typescript@~7.0.2`, and that is not a
counter-example.** It builds with Vite and never emits `.d.ts`, so neither
blocker applies there. Do not cite it as evidence that this package can move.

Recheck gate (both must land): `rollup-plugin-dts` peer includes `^7.0`
**and** `@typescript-eslint` lifts its `<6.1.0` cap. Until then reject/close
the Dependabot `typescript 7` PR. 6.0.3 is current and modern, so there is no urgency.
(Switching the DTS generator to api-extractor or plain `tsc` emit could unblock
sooner, but that's a deliberate toolchain change, not a version bump.)
