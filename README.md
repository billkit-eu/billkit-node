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
| `client.customers` | `create`, `retrieve`, `update`, `delete`, `list`, `iter` |
| `client.products` | `create`, `retrieve`, `update`, `delete`, `list`, `iter` |
| `client.prices` | `create`, `retrieve`, `list`, `iter` |
| `client.checkoutSessions` | `create`, `retrieve` |
| `client.oneShotPayments` | `create`, `retrieve` |
| `client.subscriptions` | `retrieve`, `list`, `iter`, `cancel`, `pause`, `resume`, `previewUpdate`, `update`, `reauthorizePaymentMethod` |
| `client.refunds` | `create`, `retrieve`, `list`, `iter` |
| `client.webhookEndpoints` | `create`, `retrieve`, `update`, `delete`, `rotateSecret`, `list`, `iter`, `listDeliveries`, `iterDeliveries`, `getDelivery`, `redeliver` |
| `client.events` | `retrieve`, `list`, `iter` (filter by `type`) |
| `client.tenant` | `capabilities`, `portalBranding`, `setPortalBranding`, `rotateProviderCredential` |
| `client.coupons` | `create`, `retrieve`, `update`, `delete`, `validate`, `list`, `iter` |
| `client.taxRates` | `create`, `retrieve`, `update`, `delete`, `list`, `iter` |
| `client.invoices` | `retrieve`, `list`, `iter` |
| `client.auditLogs` | `retrieve`, `list`, `iter` (filter by `action`, `resource_type`, `actor_id`) |
| `client.payments` | `retrieve`, `list`, `iter` |
| `client.billingPortalSessions` | `create`, `revoke` |

## Auto-pagination

Every list-returning resource ships an `iter()` async iterator that walks the Stripe-shape `has_more` + `starting_after` cursor protocol for you. No more manual cursor loops:

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
  apiKey: "sk_test_...",                  // or set BILLKIT_API_KEY
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

## Logging

The SDK is **silent by default**. It ships no logger, no transport and no destination, so it can't take over your application's output because it never picks one. Hand it a logger to opt in:

```ts
const client = new BillKit({ apiKey: "sk_test_...", logger: console });
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
  apiKey: "sk_test_...",
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
  code: "WELCOME10",
  discount_type: "percentage",
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
