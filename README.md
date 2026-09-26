# BillKit Node.js SDK

TypeScript-first client for [BillKit](https://billkit.eu), the Stripe-Billing-shape multi-tenant SaaS API on Mollie. Works in Node 20+, Bun, Deno, Cloudflare Workers, and any modern browser runtime.

## Install

```bash
npm install @billkit-eu/sdk
# or pnpm add @billkit-eu/sdk / yarn add @billkit-eu/sdk / bun add @billkit-eu/sdk
```

Requires Node 20+ (or any runtime with native `fetch` + `crypto.subtle`).

## Quick start

```ts
import { BillKit } from "@billkit-eu/sdk";

const client = new BillKit({ apiKey: process.env.BILLKIT_API_KEY });

interface Customer {
  id: string;
}

interface Product {
  id: string;
}

interface Price {
  id: string;
}

interface CheckoutSession {
  url: string;
}

const customer = await client.customers.create<Customer>({
  email: "ada@example.com",
  name: "Ada Lovelace",
});

const product = await client.products.create<Product>({
  name: "Pro",
  description: "Hosted billing for SaaS",
  marketing_features: ["Checkout", "Subscriptions"],
});

const price = await client.prices.create<Price>({
  product_id: product.id,
  amount_cents: 999,
  currency: "EUR",
  interval: "month",
  trial_days: 14,
  payment_methods: ["creditcard", "directdebit"],
});

const session = await client.checkoutSessions.create<CheckoutSession>({
  customer_id: customer.id,
  price_id: price.id,
  success_url: "https://app.example.com/success",
  cancel_url: "https://app.example.com/cancel",
});

console.log(session.url); // redirect the user here
```

### One-shot (mandate-less) payments

A one-shot is a single charge with no subscription, mandate or renewals: the Stripe PaymentIntent shape, mapped onto Mollie. Create it, redirect to `redirect_url`, and settle terminal state via the `one_shot_payment.succeeded` / `.failed` webhook events.

```ts
const payment = await client.oneShotPayments.create({
  customer_id: customer.id,
  amount_cents: 2500,
  currency: "EUR",
  method: "ideal",
  success_url: "https://shop.example.com/thanks",
  refund_window_days: 14, // optional; 0 disables refunds, default is 30
});

console.log(payment.redirect_url); // redirect the payer here

// Later, refund it within its window (omit amount_cents for a full refund):
await client.refunds.create({ one_shot_payment_id: payment.id });
// ...or refund part of it. A charge can carry several partials:
await client.refunds.create({ one_shot_payment_id: payment.id, amount_cents: 500 });
```

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
| `client.webhookEndpoints` | `create`, `retrieve`, `update` (stop delivery with `status: "disabled"`), `delete`, `rotateSecret`, `list`, `iter`, `listDeliveries`, `iterDeliveries`, `retrieveDelivery`, `redeliver` |
| `client.events` | `retrieve`, `list`, `iter` (filter by `type`) |
| `client.tenant` | `capabilities`, `portalBranding`, `setPortalBranding`, `rotateProviderCredential` |
| `client.coupons` | `create`, `retrieve`, `update` (withdraw with `active: false`), `validate`, `list`, `iter` |
| `client.taxRates` | `create`, `retrieve`, `update` (retire with `active: false`), `list`, `iter` |
| `client.invoices` | `retrieve`, `retrievePdf`, `list`, `iter`, `void` |
| `client.creditNotes` | `retrieve`, `retrievePdf`, `list`, `iter` (filter by `invoice_id`, `customer_id`) |
| `client.auditLogs` | `retrieve`, `list`, `iter` (filter by `action`, `resource_type`, `resource_id`, `actor_id`) |
| `client.payments` | `retrieve` (`expand: ["refund_eligibility"]` says whether a refund would succeed now), `list`, `iter` |
| `client.billingPortalSessions` | `create`, `revoke` |

### Clearing an optional field

On an update, an explicit `null` clears a field and omitting it leaves the stored value alone. Only `undefined` is pruned from a request body, so `null` reaches the API as a JSON null. This applies to `products.update` (`description`, `default_price_id`), `customers.update` (`name`), `webhookEndpoints.update` (`description`), `coupons.update` (`max_redemptions` removes the cap, `redeem_by` removes the expiry) and `taxRates.update` (`display_name`).

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
const paused = await client.subscriptions.list({ renewal_state: "paused" });
```

`status: "paused"` is not an accepted value and comes back as `InvalidRequestError`. Both filters take a comma-separated list (`status: "active,past_due"`), and an unrecognised value is rejected rather than silently ignored.

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
    { up_to: 1000, unit_amount: 1 },                // first 1,000 at EUR 0.01
    { up_to: "inf", unit_amount_decimal: "0.5" },   // then EUR 0.005
  ],
});
```

`amount_cents` is optional for that reason. Send none of the three and the server refuses the price.

**`unit_amount_decimal` is a `string`, and a `number` will not compile.** A JS number is an IEEE-754 double and cannot hold 0.0002 exactly, so accepting one would work for the rates that happen to round-trip and silently mis-price the ones that do not. A number that reaches it anyway (plain JavaScript, a value through `any`, a parsed body) is rejected with a `TypeError` before the request goes out. The same applies to a band's `unit_amount_decimal`.

The rate is in **minor units**, so `"0.02"` is two hundredths of a cent, not two cents. The period's whole quantity is multiplied by the rate and rounded once, at the invoice, so a sub-cent rate loses nothing per record.

The last band must be `up_to: "inf"`, because a bounded top band cannot price the usage above it. Write a free band as `unit_amount: 0`. Metered prices must use `interval: "month"`, cannot have `trial_days`, and cannot set `refund_on_cancel`.

#### Reporting usage exactly once

```ts
await client.subscriptions.createUsageRecord(sub.id, {
  quantity: 1200,
  identifier: "job-2026-09-19T10:00Z", // your id for what you are metering
});
```

Two dedupe mechanisms, and they cover different failures. The `Idempotency-Key` the SDK sends covers a retry of *that HTTP request*, including its own internal retries. `identifier` covers a retry of *your* call — a job runner replaying a task, a queue delivering twice, your code re-invoking after its own timeout — which reaches the API as a genuinely new request with a new key. A second report of the same identifier returns the first record unchanged rather than billing twice. If your reporting pipeline is at-least-once, `identifier` is the one that matters.

Records are immutable once written: they are the audit trail behind an invoice line, so there is no update or delete.

#### Knowing what the next invoice will be

```ts
const summary = await client.subscriptions.retrieveUsageSummary<{
  pending_quantity: number;
  gross_cents: number;
  will_charge: boolean;
  minimum_charge_cents: number;
}>(sub.id);
```

Check `will_charge` before you promise a customer an amount. A period whose total is under `minimum_charge_cents` (EUR 1.00) is **not** charged, because the payment provider would refuse it. The usage is not lost: it stays pending and rolls into the next period, which is then billed for both. `net_cents` / `tax_cents` / `gross_cents` are computed through the same rate or tier table and the same VAT resolution the close itself uses, so this is a forecast of the real invoice rather than an estimate. `open_invoice_id` names an earlier cycle that is invoiced and still unsettled; while one is open, this period cannot be charged.

### Embedded checkout

Pass `ui_mode: "embedded"` and the session comes back with a `client_secret` instead of a `url`. Hand that to [`@billkit-eu/js`](https://www.npmjs.com/package/@billkit-eu/js) or [`@billkit-eu/react`](https://www.npmjs.com/package/@billkit-eu/react) and the card fields render on your own page, inside a cross-origin iframe. `cancel_url` is still required.

```ts
const session = await client.checkoutSessions.create<{ client_secret: string }>({
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

Returns the raw bytes. S3-backed deployments answer with a redirect to a presigned URL, which is followed transparently under the SDK's own timeout and retry policy, so both storage adapters look the same from here — and the API key is never sent to the storage host, because the presigned URL carries its own credential. A deployment with PDF rendering disabled throws a `ServerError` with `code: "rendering_pending"`; `retrieve()` still gives you the structured document to render yourself.

## Auto-pagination

Every list-returning resource ships an `iter()` async iterator that walks the Stripe-shape `has_more` + `starting_after` cursor protocol for you. Pagination is forward-only — BillKit has no `ending_before` — so page backwards by holding onto the cursors you have already walked.

```ts
for await (const customer of client.customers.iter()) {
  console.log(customer);
}

// Filter at the server, raise the page size to cut round-trips:
for await (const evt of client.events.iter({ type: "subscription.created", pageSize: 100 })) {
  await handle(evt);
}

// Audit walk scoped to one actor:
for await (const row of client.auditLogs.iter({ actor_id: "act_1" })) {
  await archive(row);
}
```

## Configuration

```ts
import { BillKit } from "@billkit-eu/sdk";

const client = new BillKit({
  apiKey: "bk_test_...",                  // or set BILLKIT_API_KEY
  baseUrl: "https://api.billkit.eu",   // override for self-hosted
  timeoutMs: 30_000,
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

The SDK auto-generates an `Idempotency-Key` for every mutating call, so 5xx and short `Retry-After` 429 retries are safe: the server replays the original response when an earlier attempt completed. Pass `idempotencyKey` to coalesce retries across process restarts.

`409 idempotency_in_progress` is retried too. It means an earlier request carrying the same key is still in flight, which is the one 4xx where giving up is the dangerous answer: that request may already have charged the customer, and the obvious workaround — retry with a *fresh* key — is exactly what turns one charge into two. The retry reuses the original key, so it either loses the race again or replays the first call's result. Every other 409 (`idempotency_key_in_use`, a conflicting subscription state) fails immediately, because retrying can only repeat it.

## Errors

```ts
import {
  BillKit,
  ResourceMissingError,
  RateLimitError,
  BillKitError,
} from "@billkit-eu/sdk";

try {
  const customer = await client.customers.retrieve("cus_doesnt_exist");
} catch (err) {
  if (err instanceof ResourceMissingError) {
    console.log("Customer is gone");
  } else if (err instanceof RateLimitError) {
    console.log(`Rate limited; retry in ${err.retryAfter}s`);
  } else if (err instanceof BillKitError) {
    console.log(`BillKit error ${err.statusCode}: ${err.message}`);
  } else {
    throw err;
  }
}
```

All errors inherit from `BillKitError`. Subclasses: `APIConnectionError`, `APIError`, `ServerError`, `AuthenticationError`, `PermissionError`, `ResourceMissingError`, `InvalidRequestError`, `ConflictError`, `RateLimitError`.

The class is chosen by **HTTP status**, not by the envelope's `type`:

| Status | Class |
|---|---|
| 401 | `AuthenticationError` |
| 403 | `PermissionError` |
| 404 | `ResourceMissingError` |
| 409 | `ConflictError` |
| 429 | `RateLimitError` |
| other 4xx (400, 405, 422, …) | `InvalidRequestError` |
| 5xx | `ServerError` |

The status is the field the API cannot get wrong. Requests that never reach a route handler — an unmatched path, a method the route does not allow — are serialised by the framework as `{"type": "api_error", "code": "unhandled"}` *with a 4xx status*, so mapping on `type` would turn a plain 404 into a `ServerError` and tell you BillKit had broken when the request was at fault. The envelope's `type`, `code` and `param` are all still on the thrown object if you want them.

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

**Never logged:** your API key or the `Authorization` header; request and response **bodies** (they carry customer PII); the **query string** (list filters carry values like `email=`); only the path is logged. The final failure isn't logged either: it's thrown as a typed `BillKitError` carrying the status, request id and retry-after, and logging it here too would hand you a duplicate you can't suppress.

## Webhook verification

Works in Node, Bun, Deno, Cloudflare Workers and the browser, anywhere `globalThis.crypto.subtle` exists.

```ts
import { verifyWebhookSignature, WebhookVerificationError } from "@billkit-eu/sdk";

// Hono / Express / Bun.serve / Workers fetch handler:
try {
  const event = await verifyWebhookSignature({
    payload: rawBody,                          // string or Uint8Array
    signatureHeader: request.headers.get("BillKit-Signature"),
    secret: process.env.BILLKIT_WEBHOOK_SECRET,
  });

  if (event.type === "subscription.created") {
    await handleNewSubscription(event.data);
  }

  return new Response("ok");
} catch (err) {
  if (err instanceof WebhookVerificationError) {
    return new Response("invalid signature", { status: 400 });
  }
  throw err;
}
```

The verifier enforces a 5-minute timestamp tolerance (replay protection) and constant-time HMAC compare. Pass `toleranceSeconds` to customise.

## TypeScript

Every method is generic so you can hand in your own response type:

```ts
interface Customer {
  id: string;
  email: string;
  created_at: string;
}

const customer = await client.customers.retrieve<Customer>("cus_1");
//    ^ Customer
```

The SDK doesn't ship runtime schemas (zod / valibot). The API is Stripe-shape and most callers forward the JSON through to their own data layer unchanged. Bring your own validator if you need one.

Per-call param shapes are exported for callers who want to type their inputs ahead of time:

```ts
import type {
  CreateCouponParams,
  CreateBillingPortalSessionParams,
} from "@billkit-eu/sdk";

const couponParams: CreateCouponParams = {
  // "percent" reads discount_value as whole percent; "fixed_cents" reads
  // it as minor units off the charge. Those are the only two values.
  code: "WELCOME10",
  discount_type: "percent",
  discount_value: 10,
  duration: "once",
};
await client.coupons.create(couponParams);
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

Proprietary.
