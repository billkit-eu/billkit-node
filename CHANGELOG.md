# Changelog

All notable changes to the BillKit Node SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versioning is independent of the Python SDK; the two ship on their own cadence.

## [Unreleased]

### Added
- **Opt-in logging.** Pass a `logger` to see the request/retry lifecycle:

  ```ts
  const client = new BillKit({ apiKey: "sk_test_...", logger: console });
  ```

  Omitted (the default) the SDK is silent: it ships no logger, no transport
  and no destination, so it can't take over your application's output. The
  `BillKitLogger` interface is two methods (`debug`/`warn`) that `console` and
  a pino/winston child logger already satisfy without an adapter.

  `debug` fires once per HTTP attempt and once per response (`method`, `url`,
  `attempt`, `status`, `durationMs`, `requestId`); `warn` fires once per retry
  with the reason and delay. Exported: `BillKitLogger`, `LogContext`,
  `NOOP_LOGGER`.

  API keys, request/response bodies and query strings are never passed to the
  logger, and the final failure is thrown rather than logged so you never get a
  duplicate entry.

### Changed
- **`giropay` removed from the one-shot `method` union.** Paydirekt wound the
  scheme down: Mollie stopped processing it on 2024-06-30 and giropay shut down
  entirely on 2024-12-31, so the API now rejects `method: "giropay"` with a
  `422`. The union keeps its `(string & {})` tail, so this narrows editor
  autocomplete rather than breaking compilation for anyone passing a
  `string`-typed variable. Reading back a one-shot paid with giropay before the
  shutdown is unaffected; `OneShotPayment.method` is a plain `string`.

## [0.2.2] - 2026-07

### Fixed
- Request timeout now covers the **response body read**, not just time-to-headers.
  Previously the timeout was cleared once headers arrived, so a server that
  streamed headers and then stalled the body could hang the call forever. The
  transport now uses `AbortSignal.timeout()`, which stays armed through the body
  read, and reports a clear `timed out after <n>ms` message.

### Changed
- Webhook verification accepts **multiple `v1` signatures** in one
  `BillKit-Signature` header and passes if any matches, which is required so inbound
  webhooks keep verifying while a signing secret is being rotated.

## [0.2.1] - 2026-07

### Fixed
- Default `baseUrl` corrected to `https://api.billkit.eu`. The previous
  default pointed at a host that does not exist, so callers that relied on the
  default (i.e. did not pass an explicit `baseUrl`) were reaching a dead host;
  they now reach the production API. Callers already passing `baseUrl` are
  unaffected.

## [0.2.0] - 2026-06

First public release.

### Added
- `BillKit` client, async-first, works in Node 20+, Bun, Deno, Cloudflare
  Workers, and the browser (Web Crypto API only, no Node-specific deps).
- Full resource coverage: Customers, Products, Prices, CheckoutSessions,
  Subscriptions, Refunds, WebhookEndpoints, Coupons, TaxRates, Invoices,
  AuditLogs, Payments, Events, Tenant, BillingPortalSessions.
- Async iterator pagination (`for await (const c of client.customers.iter())`).
- Typed error hierarchy (`APIConnectionError`, `AuthenticationError`,
  `PermissionError`, `ResourceMissingError`, `InvalidRequestError`,
  `ConflictError`, `RateLimitError`, `ServerError`) matching the BillKit
  error envelope.
- Automatic `Idempotency-Key` header on mutating calls; overridable per-call.
- Retry policy: 4 attempts, jittered exponential backoff, network + 5xx +
  429 with `Retry-After`.
- Configurable `timeoutMs` (default 30_000).
- `verifyWebhookSignature({ payload, signatureHeader, secret })` for
  verifying `BillKit-Signature` webhooks (HMAC-SHA256 via Web Crypto,
  5-min replay protection).
- ESM + CJS dual-package via `tsup`; `.d.ts` types shipped.

[Unreleased]: https://github.com/billkit-eu/billstack/compare/sdk-node-v0.2.2...HEAD
[0.2.2]: https://github.com/billkit-eu/billstack/compare/sdk-node-v0.2.1...sdk-node-v0.2.2
[0.2.1]: https://github.com/billkit-eu/billstack/compare/sdk-node-v0.2.0...sdk-node-v0.2.1
[0.2.0]: https://github.com/billkit-eu/billstack/releases/tag/sdk-node-v0.2.0
