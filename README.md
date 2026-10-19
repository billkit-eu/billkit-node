# BillKit Node.js SDK

TypeScript-first client for [BillKit](https://billkit.eu), the Stripe-Billing-shape multi-tenant SaaS API on Mollie. Supported on Node.js 22 and 24. It uses only fetch and crypto.subtle, so other runtimes may work, but nothing tests them.

Follows semantic versioning from 1.0.0. Coming from 0.x, see [Upgrading from 0.x](#upgrading-from-0x).

## Install

```bash
npm install @billkit-eu/sdk
# or pnpm add @billkit-eu/sdk / yarn add @billkit-eu/sdk / bun add @billkit-eu/sdk
```

Requires Node 22+ (or any runtime with native `fetch` + `crypto.subtle`).

## Quick start

```ts
import { BillKit } from "@billkit-eu/sdk";

const client = new BillKit({ apiKey: process.env.BILLKIT_API_KEY });

const customer = await client.customers.create({
  email: "ada@example.com",
  name: "Ada Lovelace",
});

const product = await client.products.create({
  name: "Pro",
  description: "Hosted billing for SaaS",
  marketing_features: ["Checkout", "Subscriptions"],
});

const price = await client.prices.create({
  product_id: product.id,
  amount_cents: 999,
  currency: "EUR",
  interval: "month",
  trial_days: 14,
  payment_methods: ["creditcard", "directdebit"],
});

const session = await client.checkoutSessions.create({
  customer_id: customer.id,
  price_id: price.id,
  success_url: "https://app.example.com/success",
  cancel_url: "https://app.example.com/cancel",
});

console.log(session.url); // redirect the user here
```

Every response is a plain object typed from the API's published OpenAPI document: `customer` is a `Customer`, `session` a `CheckoutSession`. See [Responses](#responses).

### One-shot (mandate-less) payments

A one-shot is a single charge with no subscription, mandate or renewals: the Stripe PaymentIntent shape, mapped onto Mollie. Create it, redirect to `redirect_url`, and settle terminal state via the `one_shot_payment.succeeded` / `.failed` webhook events.

```ts
const payment = await client.oneShotPayments.create({
  customer_id: customer.id,
  amount_cents: 2500,
  currency: "EUR",
  payment_method: "ideal",
  success_url: "https://shop.example.com/thanks",
  refund_window_days: 14, // optional; 0 disables refunds, default is 30
});

console.log(payment.redirect_url); // redirect the payer here

// Later, refund it within its window (omit amount_cents for a full refund):
await client.refunds.create({ one_shot_payment_id: payment.id });
// ...or refund part of it. A charge can carry several partials:
await client.refunds.create({ one_shot_payment_id: payment.id, amount_cents: 500 });
```

To take the payment inside your own page instead of redirecting to Mollie, create it with `ui_mode: "embedded"` and no `payment_method`, then hand the `client_secret` (and nothing else) to the browser, where `mountOneShotPaymentElement` from `@billkit-eu/js` (or `<OneShotPaymentElement/>` from `@billkit-eu/react`) lets the payer pick a method and pay:

```ts
const embedded = await client.oneShotPayments.create({
  customer_id: customer.id,
  amount_cents: 2500,
  currency: "EUR",
  ui_mode: "embedded",
  success_url: "https://shop.example.com/thanks",
});
// embedded.client_secret: short-lived, on the create response only.
```

`redirect_url` is `null` and `payment_method` stays `null` until the payer confirms. Fulfil from the same `one_shot_payment.succeeded` webhook as a hosted one-shot.

## Resources

The client exposes one accessor per resource family. Each mirrors the verbs from `/v1/<resource>` 1:1:

| Accessor | Verbs |
| --- | --- |
| `client.customers` | `create`, `retrieve`, `update`, `delete`, `list` (filter by `provisional`), `iter`, `setVatNumber`, `purge` |
| `client.products` | `create`, `retrieve`, `update` (archive with `active: false`), `list`, `iter` |
| `client.prices` | `create`, `retrieve`, `update` (archive with `active: false`, restore with `active: true`), `list`, `iter` |
| `client.checkoutSessions` | `create`, `retrieve` |
| `client.oneShotPayments` | `create`, `retrieve`, `list`, `iter` (filter by `customer_id`, `status`) |
| `client.subscriptions` | `retrieve`, `list`, `iter` (filter by `customer_id`, `status`, `renewal_state`), `cancel`, `pause`, `resume`, `reactivate`, `previewUpdate`, `update`, `reauthorizePaymentMethod`, `createUsageRecord`, `listUsageRecords`, `iterUsageRecords`, `retrieveUsageSummary` |
| `client.refunds` | `create`, `retrieve`, `list`, `iter` |
| `client.disputes` | `retrieve`, `list`, `iter` |
| `client.webhookEndpoints` | `create`, `retrieve`, `update` (stop delivery with `status: "disabled"`), `delete`, `rotateSecret`, `list`, `iter`, `listEventTypes`, `listDeliveries`, `iterDeliveries`, `retrieveDelivery`, `redeliver` |
| `client.events` | `retrieve`, `list`, `iter` (filter by `type`) |
| `client.tenant` | `retrieveCapabilities`, `retrieveBillingProfile`, `setBillingProfile`, `retrievePortalBranding`, `setPortalBranding`, `rotateProviderCredential`, `export` |
| `client.apiKeys` | `create`, `retrieve`, `revoke`, `list`, `iter` |
| `client.coupons` | `create`, `retrieve`, `update` (withdraw with `active: false`), `validate`, `list`, `iter` |
| `client.taxRates` | `create`, `retrieve`, `update` (retire with `active: false`), `list`, `iter` |
| `client.invoices` | `retrieve`, `retrievePdf`, `sendEmail`, `list`, `iter`, `void` |
| `client.creditNotes` | `retrieve`, `retrievePdf`, `list`, `iter` (filter by `invoice_id`, `customer_id`) |
| `client.auditLogs` | `retrieve`, `list`, `iter` (filter by `action`, `resource_type`, `resource_id`, `actor_id`) |
| `client.payments` | `retrieve` (`expand: ["refund_eligibility"]` says whether a refund would succeed now), `retrieveProvider`, `list`, `iter` |
| `client.billingPortalSessions` | `create`, `revoke` |
| `client.testClocks` | `create`, `retrieve`, `advance`, `delete`, `list`, `iter` (test mode only) |

Signatures follow one rule: the object's id first when there is one, then the call's parameters, then [request options](#request-options) last. Every method has the parameters slot, including the ones the API takes no parameters for yet (`cancel`, `revoke`, `retrieve` on most resources): those type it as `EmptyParams`, which only `{}` fits, so a parameter the API adds later is an additive change rather than a new argument. Pass `{}` to reach the options: `client.subscriptions.cancel(sub.id, {}, { idempotencyKey: "cancel-42" })`. A request option in the parameters slot is refused with a `TypeError` naming the fix. Every id argument must be non-empty: `customers.retrieve("")` rejects with a `TypeError` before any request is made.

### Erasing a customer

`customers.purge` erases a customer's personal data (GDPR Article 17) and cannot be undone. It needs `{ confirmed: true }`, and without it the call is refused before anything is sent:

```ts
const purged = await client.customers.purge(customer.id, { confirmed: true });
// { id: "cus_...", object: "customer", deleted: true, purged: true }
```

It resolves to the same marker `delete()` does, plus `purged: true`, and the customer 404s afterwards. `delete()` is different: the customer leaves the API, but their data stays until you purge it.

### Clearing an optional field

On an update, an explicit `null` clears a field and omitting it leaves the stored value alone. Only `undefined` is pruned from a request body, so `null` reaches the API as a JSON null. This applies to `products.update` (`description`, `default_price_id`, `marketing_features` empties the list), `prices.update` (`payment_methods` drops the price's own list so it follows the account's payment methods again; `refund_window_initial_days` and `refund_window_renewal_days` drop the price's override), `customers.update` (`name`), `webhookEndpoints.update` (`description`), `coupons.update` (`max_redemptions` removes the cap, `redeem_by` removes the expiry, `applies_to_price_ids` lifts the price restriction, `min_amount_cents` lifts the minimum) and `taxRates.update` (`display_name`). Every other update field is typed without `null`, and the API refuses a null there with a 400 naming the field. A `metadata` update replaces the stored object whole, so `metadata: {}` is how it is emptied.

### Retiring something, and deleting something

`delete()` exists on `customers` and `webhookEndpoints`, and it resolves to `{ id, object, deleted: true }` rather than the object: it has left the API, so there is nothing to hand back. A deleted endpoint takes its delivery rows with it, because those are readable only through the endpoint that owns them; the events stay in `client.events`, which is the record of what you were sent.

The catalogue is retired through its update route instead, because it stays readable afterwards. A price, a product, a tax rate and a coupon each take `active: false`. Each of them has to survive: subscriptions renew against a price by id, an invoice records the VAT percentage a tax rate produced, and a redeemed coupon is part of what a customer was charged.

`status: "disabled"` on a webhook endpoint is the other half of the pair, not a substitute for deleting. It stops delivery and keeps the endpoint, its secret and its history, and it can be turned back on.

```ts
// Stop selling a price. It stays readable; customers on it keep renewing.
await client.prices.update(price.id, { active: false });
// ...and put it back. The amount never moved.
await client.prices.update(price.id, { active: true });

// Stop sending to an endpoint, without losing its signing secret.
await client.webhookEndpoints.update(endpoint.id, { status: "disabled" });
// Remove one entirely, along with its delivery rows.
await client.webhookEndpoints.delete(endpoint.id); // → { deleted: true, ... }

// Remove a customer. Refused while they hold a subscription that can
// still charge them.
await client.customers.delete(customer.id); // → { deleted: true, ... }
```

### Finding paused subscriptions

`status` and `renewal_state` answer different questions, and only one of them knows about pausing. `status` is where the subscription stands with its payments (`incomplete`, `trialing`, `active`, `past_due`, `canceled`). `renewal_state` is what happens when the current period ends (`auto_renew`, `paused`, `canceling`, `stopped`). Pausing sets `renewal_state` and leaves `status` at `active`, because the customer has paid for the period they are in:

```ts
const paused = await client.subscriptions.list({ renewal_state: ["paused"] });
```

`status: ["paused"]` is not an accepted value and comes back as `InvalidRequestError`. Both filters take an array and match any of its values (`status: ["active", "past_due"]`, sent as `status=active,past_due`), and an unrecognised value is rejected rather than silently ignored. `disputes.list` `status` and `events.list` `type` take an array the same way.

### Metered billing

A metered price charges for what was consumed. You report usage; at each period close BillKit invoices the period's total and charges the stored mandate.

There are three ways to price a unit, and a price uses exactly one of them.

```ts
// 1. Whole minor units: 5 cents per unit.
await client.prices.create({
  product_id: product.id, amount_cents: 5,
  currency: "EUR", interval: "month", usage_type: "metered",
});

// 2. Finer than a minor unit. "0.02" is 0.02 CENTS, i.e. EUR 0.0002 per unit:
//    the canonical per-API-call price, which no integer can express.
await client.prices.create({
  product_id: product.id, unit_amount_decimal: "0.02",
  currency: "EUR", interval: "month", usage_type: "metered",
});

// 3. By bands. "graduated" prices the units inside each band; "volume" lets
//    the period total pick one band which then prices every unit. The same
//    table under the two modes is a different bill, so the mode is required.
await client.prices.create({
  product_id: product.id, currency: "EUR", interval: "month",
  usage_type: "metered", billing_scheme: "tiered", tiers_mode: "graduated",
  tiers: [
    { up_to: 1000, unit_amount_cents: 1 },          // first 1,000 at EUR 0.01
    { up_to: "inf", unit_amount_decimal: "0.5" },   // then EUR 0.005
  ],
});
```

`amount_cents` is optional for that reason. Send none of the three and the server refuses the price.

**`unit_amount_decimal` is a `string`, and a `number` will not compile.** A JS number is an IEEE-754 double and cannot hold 0.0002 exactly, so accepting one would work for the rates that happen to round-trip and silently mis-price the ones that do not. A number that reaches it anyway (plain JavaScript, a value through `any`, a parsed body) is rejected with a `TypeError` before the request goes out. The same applies to a band's `unit_amount_decimal`.

The rate is in **minor units**, so `"0.02"` is two hundredths of a cent, not two cents. The period's whole quantity is multiplied by the rate and rounded once, at the invoice, so a sub-cent rate loses nothing per record.

The last band must be `up_to: "inf"`, because a bounded top band cannot price the usage above it (the price comes back with that band's `up_to` as `null`). Write a free band as `unit_amount_cents: 0`. The input type is `PriceTierParams`; `PriceTier` is the band as the API returns it. Metered prices must use `interval: "month"`, cannot have `trial_days`, and cannot set `refund_on_cancel`.

#### Reporting usage exactly once

```ts
await client.subscriptions.createUsageRecord(sub.id, {
  quantity: 1200,
  identifier: "job-2026-09-19T10:00Z", // your id for what you are metering
});
```

Two dedupe mechanisms, and they cover different failures. The `Idempotency-Key` the SDK sends covers a retry of *that HTTP request*, including its own internal retries. `identifier` covers a retry of *your* call (a job runner replaying a task, a queue delivering twice, your code re-invoking after its own timeout), which reaches the API as a genuinely new request with a new key. A second report of the same identifier returns the first record unchanged rather than billing twice. If your reporting pipeline is at-least-once, `identifier` is the one that matters.

Records are immutable once written: they are the audit trail behind an invoice line, so there is no update or delete.

#### Knowing what the next invoice will be

```ts
const summary = await client.subscriptions.retrieveUsageSummary(sub.id);
if (summary.will_charge) console.log(`next charge: ${summary.gross_cents} cents`);
```

Check `will_charge` before you promise a customer an amount. A period whose total is under `minimum_charge_cents` (EUR 1.00) is **not** charged, because the payment provider would refuse it. The usage is not lost: it stays pending and rolls into the next period, which is then billed for both. `net_cents` / `tax_cents` / `gross_cents` are computed through the same rate or tier table and the same VAT resolution the close itself uses, so this is a forecast of the real invoice rather than an estimate. `open_invoice_id` names an earlier cycle that is invoiced and still unsettled; while one is open, this period cannot be charged.

### Embedded checkout

Pass `ui_mode: "embedded"` and the session comes back with a `client_secret` instead of a `url`. Hand that to [`@billkit-eu/js`](https://www.npmjs.com/package/@billkit-eu/js) or [`@billkit-eu/react`](https://www.npmjs.com/package/@billkit-eu/react) and the card fields render on your own page, inside a cross-origin iframe. `cancel_url` is still required.

```ts
const session = await client.checkoutSessions.create({
  customer_id: customer.id,
  price_id: price.id,
  ui_mode: "embedded",
  success_url: "https://app.example.com/success",
  cancel_url: "https://app.example.com/cancel",
  metadata: { order_id: "ord_42" },
});
```

### Invoice and credit-note PDFs

```ts
const pdf = await client.invoices.retrievePdf("inv_123");
await writeFile("invoice.pdf", Buffer.from(pdf));

const credit = await client.creditNotes.retrievePdf("cn_123");
```

Resolves to an `ArrayBuffer`. S3-backed deployments answer with a redirect to a presigned URL, which is followed transparently under the SDK's own timeout and retry policy, so both storage adapters look the same from here, and the API key is never sent to the storage host, because the presigned URL carries its own credential. A deployment with PDF rendering disabled throws a `ServerError` with `code: "rendering_pending"`; `retrieve()` still gives you the structured document to render yourself.

### Exporting your account

`tenant.export()` resolves to a `ReadableStream<Uint8Array>` of the whole account as one JSON document. Stream it to a file rather than holding it in memory:

```ts
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const body = await client.tenant.export();
await pipeline(Readable.fromWeb(body), createWriteStream("billkit-export.json"));
```

The per-attempt `timeout` covers the response headers only, and there is no timeout after them: the body is yours to read at your own pace, so pass a `signal` to bound it. A connection lost partway through errors the stream with an `APIConnectionError`, with the runtime's error on `cause`.

### Test clocks

A test clock is virtual time for test mode. Create one, create customers on it, then advance it: trials end, renewals fall due and dunning runs for that clock's customers only, and the work is done before `advance()` resolves.

```ts
const clock = await client.testClocks.create({
  frozen_time: Math.floor(Date.now() / 1000),
  name: "Trial ends",
});
const customer = await client.customers.create({ email: "ada@example.com", test_clock_id: clock.id });
// ...start a trial subscription for the customer, then jump past it:
await client.testClocks.advance(clock.id, { frozen_time: clock.frozen_time + 15 * 86_400 });

await client.testClocks.delete(clock.id); // → { deleted: true, ... }; its customers return to real time
```

`test_clock_id` is fixed when the customer is created. `frozen_time` on `advance()` must be later than the clock's current time. Every route answers a live key with an `InvalidRequestError`.

## Auto-pagination

Every list-returning resource ships an `iter()` async iterator that walks the Stripe-shape `has_more` + `starting_after` cursor protocol for you. `iter()` takes exactly what `list()` takes: every filter is carried onto every page, `limit` is the page size, and `starting_after` is where to begin. Pagination is forward-only; BillKit has no `ending_before`.

```ts
for await (const customer of client.customers.iter()) {
  console.log(customer);
}

// Filter at the server, raise the page size to cut round-trips:
for await (const evt of client.events.iter({ type: ["subscription.created"], limit: 100 })) {
  await handle(evt);
}

// Audit walk scoped to one actor:
for await (const row of client.auditLogs.iter({ actor_id: "act_1" })) {
  await archive(row);
}
```

## Responses

Every method resolves to a plain object typed from the API's public OpenAPI document, generated into `src/generated/models.ts` and exported from the package: `Customer`, `Subscription`, `Invoice`, `ListResponse<T>`, `DeletedResource` and the rest. There are no classes and no runtime validation, so the JSON is exactly what the API sent.

```ts
import type { Subscription } from "@billkit-eu/sdk";

const sub: Subscription = await client.subscriptions.retrieve("sub_123", { expand: ["price"] });
sub.renewal_state; // "auto_renew" | "paused" | "canceling" | "stopped" | (string & {})
sub.price?.amount_cents;
```

**The types are open where the API is.** An enum-like field lists the values this SDK version knows, widened with `string`, so your editor autocompletes them and a value the API adds later is neither a compile error nor a runtime one. Handle the values you know and treat anything else as newer, not as a failure. A field added after this SDK version is on the object at runtime too; nothing strips or rejects it.

Each method also takes a type parameter for the rare caller who wants to narrow further: `client.customers.retrieve<MyCustomer>(id)`. It is an unchecked assertion, so prefer the default.

## Request options

Every method takes one more argument, last, after its parameters, that controls how the call is sent rather than what it says. On a call that takes no parameters yet, pass `{}` before it: `client.invoices.sendEmail(id, {}, { timeout: 10_000 })`.

```ts
const refund = await client.refunds.create(
  { payment_id: payment.id, amount_cents: 500 },
  {
    idempotencyKey: `refund-${orderId}`, // converge across process restarts
    timeout: 10_000,                     // ms per attempt, for this call only
    maxRetries: 1,                       // 0 sends exactly one attempt
    headers: { "X-Request-Source": "admin" },
    signal: controller.signal,           // an AbortSignal
  },
);
```

An aborted call is never retried, and it rejects with the signal's `reason` (a `DOMException` named `AbortError` unless you passed your own), exactly as `fetch` does. A key that is not one of these five, or an `idempotencyKey` left in the parameters, is refused with a `TypeError` before anything is sent, and that includes a superset object such as your own config with the options spread in. A key whose value is `undefined` counts as absent. `headers` cannot set `Authorization`, `Idempotency-Key`, `Content-Type` or `User-Agent` (in any case), and every value must be a string; choose the key with `idempotencyKey`.

## Configuration

```ts
import { BillKit } from "@billkit-eu/sdk";

const client = new BillKit({
  apiKey: "bk_test_...",                  // or leave it out and set BILLKIT_API_KEY
  baseUrl: "https://api.billkit.eu",   // override for self-hosted
  timeout: 30_000,                        // ms per attempt; per-call `timeout` overrides it
  maxRetries: 3,                          // retries after the first attempt; per-call too
  retryPolicy: {
    maxAttempts: 5,
    initialBackoffMs: 500,
    backoffMultiplier: 2,
    maxBackoffMs: 8000,
    maxRetryAfterMs: 10_000,
    jitter: 0.25,
  },
  fetch: customFetch, // inject for tests / proxies
  logger: console,     // opt-in; omitted = silent (see Logging)
});
```

`maxRetries`, when given, overrides `retryPolicy.maxAttempts` (it counts retries, so attempts are `maxRetries + 1`).

The SDK generates an `Idempotency-Key` for every mutating call, once per call and reused on every retry, so retries of a 5xx (every one except 501) or a short `Retry-After` 429 are safe: the server replays the original response when an earlier attempt completed. Pass `idempotencyKey` in the request options to coalesce retries across process restarts. A blank or whitespace-only `idempotencyKey`, or `null`, counts as not passed, and the SDK generates one. A number is sent as its decimal string; a boolean or object rejects with a `TypeError` before any request.

The SDK never follows a redirect on a JSON call: a `3xx` throws `InvalidRequestError` rather than re-sending the body to the `Location` target. The API does not redirect `/v1` calls, so one usually means `baseUrl` is wrong. The PDF calls are the exception, see above.

`409 idempotency_in_progress` is retried too. It means an earlier request carrying the same key is still in flight, which is the one 4xx where giving up is the dangerous answer: that request may already have charged the customer, and the obvious workaround (retry with a *fresh* key) is exactly what turns one charge into two. The retry reuses the original key, so it either loses the race again or replays the first call's result. Every other 409 (`idempotency_key_in_use`, a conflicting subscription state) fails immediately, because retrying can only repeat it.

## Errors

```ts
import { APIError, NotFoundError, RateLimitError } from "@billkit-eu/sdk";

try {
  const customer = await client.customers.retrieve("cus_doesnt_exist");
} catch (err) {
  if (err instanceof NotFoundError) {
    console.log("Customer is gone");
  } else if (err instanceof RateLimitError) {
    console.log(`Rate limited; retry in ${err.retryAfter}s`);
  } else if (err instanceof APIError) {
    console.log(`BillKit error ${err.statusCode} (${err.requestId}): ${err.message}`);
  } else {
    throw err;
  }
}
```

The hierarchy, with the same names and meaning in every BillKit SDK:

```
BillKitError
├── APIError                   any HTTP error response
│   ├── InvalidRequestError    400 and any other 4xx not listed below
│   ├── AuthenticationError    401
│   ├── PaymentError           402, a payment the call needed was refused
│   ├── PermissionDeniedError  403
│   ├── NotFoundError          404
│   ├── ConflictError          409
│   ├── RateLimitError         429, with retryAfter (seconds)
│   └── ServerError            5xx
├── APIConnectionError         no answer: DNS, TCP, TLS, a reset
│   └── APITimeoutError        no answer in time
└── WebhookVerificationError
```

An `APIError` carries `statusCode`, `requestId` (quote it to support), `headers`, `rawBody` and the envelope's `type`, `code`, `param` and `reason`. `type`, `code` and `reason` are open strings: compare against the values you handle. A 2xx whose body is not JSON is a plain `APIError` too, rather than a success with nothing in it. `APIConnectionError` keeps the runtime's own failure on `cause`.

A `402` is a `PaymentError`: the request was fine, but a payment it depended on could not be made. Its `type` is `payment_error` and its `code` is `payment_refused` when the payment provider refused a charge or refund the call had to make on the spot (no money moved and nothing changed; for a charge, the customer's payment method usually needs replacing), or `tenant_suspended` when your own BillKit account is suspended. It is not retried.

The class is chosen by **HTTP status**, not by the envelope's `type`. The status is the field nothing in between can get wrong. An unmatched path is a 404 with `type: "invalid_request_error"` and `code: "route_not_found"`, so mapping on `type` would raise an invalid-request error for what is a missing resource; and a 4xx whose body says `api_error` (as a proxy in front of the API can send) would become a `ServerError` and tell you BillKit had broken when the request was at fault.

**`instanceof` works across module copies.** The package ships ESM and CommonJS builds, and an application can end up loading both. Every error class is branded under a `Symbol.for` key, so `err instanceof NotFoundError` is true whichever copy threw it. Each error's `name` is set too, for code that prefers comparing strings.

## Logging

The SDK is **silent by default**. It ships no logger, no transport and no destination, so it can't take over your application's output because it never picks one. Hand it a logger to opt in:

```ts
const client = new BillKit({ apiKey: "bk_test_...", logger: console });
```

```
BillKit request  { method: 'POST', url: 'https://api.billkit.eu/v1/customers', attempt: 1, maxAttempts: 3 }
BillKit response { method: 'POST', url: '.../v1/customers', status: 503, durationMs: 84, requestId: 'req_9f2a' }
BillKit retrying { method: 'POST', url: '.../v1/customers', reason: 'HTTP 503', attempt: 1, delayMs: 500 }
BillKit response { method: 'POST', url: '.../v1/customers', status: 200, durationMs: 91, requestId: 'req_9f2b' }
```

- **`debug`**: one call per attempt, one per response (`status`, `durationMs`, `requestId`; quote that id to support).
- **`warn`**: one call per retry, with the reason and the delay before the next attempt.

`console` satisfies the interface as-is, and so does a pino/winston/bunyan child logger. It's deliberately two methods:

```ts
interface BillKitLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}
```

If your logger takes context first, wrap it:

```ts
const client = new BillKit({
  apiKey: "bk_test_...",
  logger: {
    debug: (m, c) => pino.debug(c, m),
    warn: (m, c) => pino.warn(c, m),
  },
});
```

**Never logged:** your API key or the `Authorization` header; request and response **bodies** (they carry customer PII); the **query string** (list filters carry values like `email=`); only the path is logged. The final failure isn't logged either: it's thrown as a typed `APIError` carrying the status, request id and retry-after, and logging it here too would hand you a duplicate you can't suppress.

## Webhook verification

Uses `globalThis.crypto.subtle` only, no Node-specific API.

```ts
import { isKnownEventType, verifyWebhookSignature, WebhookVerificationError } from "@billkit-eu/sdk";

// Any fetch-style handler (Hono, Next.js route handlers, ...):
try {
  const event = await verifyWebhookSignature({
    payload: rawBody,                          // string or Uint8Array
    signatureHeader: request.headers.get("BillKit-Signature"),
    secret: process.env.BILLKIT_WEBHOOK_SECRET!,
  });

  // A type newer than this SDK: acknowledge it, or BillKit retries it.
  if (!isKnownEventType(event)) return new Response("ok");
  switch (event.type) {
    case "subscription.created":
      await handleNewSubscription(event.data); // a Subscription
      break;
    case "invoice.paid":
      await markPaid(event.data.id);           // an Invoice
      break;
  }
  return new Response("ok");
} catch (err) {
  if (err instanceof WebhookVerificationError) {
    return new Response("invalid signature", { status: 400 });
  }
  throw err;
}
```

`verifyWebhookSignature` returns `WebhookEvent | UnknownWebhookEvent`. `WebhookEvent` is the union of every event this SDK version knows, discriminated on `type`; `UnknownWebhookEvent` is a type it does not know yet, with `data: unknown`. Narrow with `isKnownEventType(event)`, then on `type`, and `data` is typed as the object that event carries. New event types are additive in 1.x, so an exhaustive check that assigns the leftover `event.type` to `never` is unsupported: the minor release that adds a type stops it compiling. `WebhookEventMap` maps each type to its body if you want to name one. The verifier enforces a 5-minute timestamp tolerance (replay protection) and a constant-time HMAC compare; pass `toleranceSeconds` to change the window. It refuses, with a `WebhookVerificationError`, a parsed object (or `undefined`) as `payload`, an empty or blank `secret` (so an unset environment variable can never make a forged signature verify), and a `t=` that is not a plain Unix timestamp.

`data` is the object itself, not a `data.object` wrapper. `previous_attributes` sits **beside** `data` and is always present: `null` when there is nothing to report, and on an update (`subscription.updated`, `customer.updated`, `price.archived` and the rest) the fields that changed, with their values before the change:

```ts
if (
  isKnownEventType(event) &&
  event.type === "subscription.updated" &&
  event.previous_attributes !== null
) {
  console.log(`status went ${String(event.previous_attributes.status)} -> ${event.data.status}`);
}
```

A newer API can deliver a type this union does not name. Nothing in the SDK rejects one, so let it fall through to "acknowledge and ignore": answering non-2xx makes BillKit retry a delivery you were never going to process. `EventTypes` holds every type as constants, `EVENT_TYPES` lists them for `webhookEndpoints.create({ enabled_events })`, and `isKnownEventType()` tells you which case you are in.

## TypeScript

Param shapes are exported for callers who build their inputs ahead of time, and checked at compile time against the request schemas the API publishes:

```ts
import type { CreateCouponParams } from "@billkit-eu/sdk";

const couponParams: CreateCouponParams = {
  code: "WELCOME10",
  percent_off: 10, // or amount_off_cents with a currency; exactly one
  duration: "once",
};
await client.coupons.create(couponParams);
```

## Upgrading from 0.x

1.0 is a deliberate break. [`CHANGELOG.md`](./CHANGELOG.md) lists every change with the code before and after; in short:

- Responses are typed: drop the generics you passed to every call.
- `idempotencyKey` moved from the parameters to the request options, the last argument.
- `timeoutMs` is `timeout`; `maxRetries` is new.
- `ResourceMissingError` is `NotFoundError` and `PermissionError` is `PermissionDeniedError`; every HTTP error extends `APIError`, timeouts are `APITimeoutError`, and the HTTP fields live on `APIError`.
- `iter()` takes `list()`'s parameters, so `pageSize` is `limit`.
- `customers.purge(id, { confirmed: true })`, which resolves to a `{ id, object, deleted, purged }` marker rather than the customer.
- `method` is `payment_method` on checkout sessions and one-shot payments, `test_clock` is `test_clock_id` on customers, and a dispute's `reversed` is `reversed_at`.
- Multi-value list filters are arrays: `status: ["active", "past_due"]`, `type: ["invoice.paid"]`.
- `tenant.retrieveCapabilities()`, `retrieveBillingProfile()`, `retrievePortalBranding()`; `tenant.export()` is a `ReadableStream`.
- Coupons take `percent_off` / `amount_off_cents`; price tiers take `unit_amount_cents` / `flat_amount_cents`.
- `verifyWebhookSignature` returns `WebhookEvent | UnknownWebhookEvent` (narrow with `isKnownEventType`) and no longer takes `nowMs`.
- Removed: `getDelivery`, `paginate`, `PaginateOptions`, `ListParams`, `ListResponseEnvelope`, `ExpandOptions`, `IdempotencyOptions`.
- A non-JSON 2xx throws `APIError`. Node 22+.

## Development

```bash
npm install
npm run generate   # regenerate src/generated/ from the public OpenAPI spec
npm run typecheck
npm test
npm run check:package   # build, publint, arethetypeswrong
```

## License

Apache-2.0
