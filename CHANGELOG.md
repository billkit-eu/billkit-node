# Changelog

All notable changes to the BillKit Node SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versioning is independent of the Python SDK; the two ship on their own cadence,
so the numbers will diverge after this first release.

## [Unreleased]

## [0.1.0]

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
- Configurable `timeoutMs` (default 30_000). The timeout covers the **response
  body read**, not just time-to-headers, so a server that streams headers and
  then stalls the body cannot hang a call indefinitely. Built on
  `AbortSignal.timeout()`, and reports a `timed out after <n>ms` message.
- `verifyWebhookSignature({ payload, signatureHeader, secret })` for
  verifying `BillKit-Signature` webhooks (HMAC-SHA256 via Web Crypto,
  5-min replay protection). Multiple `v1` signatures in one header are accepted
  and pass if any matches, which is what keeps inbound webhooks verifying
  through a signing-secret rotation.
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
- ESM + CJS dual-package via `tsup`; `.d.ts` types shipped.

### Notes
- `giropay` is absent from the one-shot `method` union. Paydirekt wound the
  scheme down: Mollie stopped processing it on 2024-06-30 and giropay shut down
  entirely on 2024-12-31, so the API rejects `method: "giropay"` with a `422`.
  The union keeps its `(string & {})` tail, so this narrows editor autocomplete
  rather than constraining anyone passing a `string`-typed variable. Reading
  back a one-shot paid with giropay before the shutdown works;
  `OneShotPayment.method` is a plain `string`.

[Unreleased]: https://github.com/billkit-eu/billkit-node/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/billkit-eu/billkit-node/releases/tag/v0.1.0
