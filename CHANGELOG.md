# Changelog

All notable changes to the BillKit Node SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versioning is independent of the Python SDK; the two ship on their own cadence,
so the numbers will diverge after this first release.

## [0.2.1]

### Changed
- Documentation only. API keys are now `bk_live_…` / `bk_test_…` and webhook
  signing secrets `bkwhsec_…`; every example here used the previous
  Stripe-shaped `sk_`/`whsec_` spelling. No code in this package changed: it
  never parsed the prefix, it forwards the key as a bearer token.

## [0.2.0]

### Added
- `client.prices.update(id, { active: false })` archives a price
  (`POST /v1/prices/{id}`). The price keeps its id and stays readable through
  `retrieve()` and `list()`, because subscriptions renew against it by id.
  Subscriptions already on it keep renewing; what stops is new business.
  Re-archiving is a no-op that returns the price unchanged, so a retry is safe.
  `active` is the only field a price accepts and `active: true` is refused,
  because prices are immutable.
- `client.subscriptions.list()` and `.iter()` now take `customer_id`, `status`
  and `renewal_state` through the new `SubscriptionsListParams`, and `iter()`
  carries the filter onto every page request instead of narrowing client-side.
  Both filters take a comma-separated list.

### Removed
- `delete()` on `products`, `prices`, `coupons`, `taxRates` and
  `webhookEndpoints`. None of them deleted anything: every one of those rows
  stays readable afterwards, which is why they have to. Retire them through the
  update route instead — `active: false` for products, prices, tax rates and
  coupons, `status: "disabled"` for webhook endpoints. The server no longer
  answers `DELETE` on those paths at all.

### Changed
- `client.customers.delete(id)` resolves to `{ id, object: "customer", deleted:
  true }` instead of the customer. The customer leaves the API, so returning a
  body that reads like a live resource said the opposite of what happened.
- `renewal_state: "paused"` is the way to find paused subscriptions.
  `status: "paused"` is no longer accepted by the API and now raises
  `InvalidRequestError`: pausing sets `renewal_state` and leaves `status` at
  `active`, because the customer has paid for the period they are in. The README
  documents the split between the two filters.

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
  const client = new BillKit({ apiKey: "bk_test_...", logger: console });
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
