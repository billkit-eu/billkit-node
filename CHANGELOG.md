# Changelog

All notable changes to the BillKit Node SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versioning is independent of the Python SDK; the two ship on their own cadence,
so the numbers will diverge after this first release.

## [Unreleased]

## [1.1.1] - 2026-10-19

### Changed
- Generated types regenerated against the current public spec: the
  `stripe_import.connected`, `stripe_import.started` and
  `subscription.imported` audit actions and the `import_not_activated`
  cancellation reason.

## [1.1.0] - 2026-10-19

### Added

- `Price` and `ExpandedPrice` carry `payment_methods_from_account`: `true`
  when the price follows the account's payment methods, `false` when it has
  its own list. When it is `true`, `payment_methods` lists the account's
  methods (every recurring method the workspace has not switched off).
- `UpdatePriceParams.payment_methods` accepts `null`, sent as a JSON null,
  which drops the price's own list so it follows the account again. Omitting
  the key still leaves it unchanged.
- Generated from API contract 1.1.0: the audit log `action` vocabulary gains
  `tenant.test_mode_email_enabled`, `tenant.test_mode_email_disabled`,
  `tenant.invoice_pdf_attach_enabled`, `tenant.invoice_pdf_attach_disabled`
  and `tenant.payment_methods_updated`.

### Changed

- A price created without `payment_methods` now follows the account's
  payment methods instead of defaulting to `["creditcard"]` (an API change in
  contract 1.1.0; the SDK never sent a default and still sends no key).
- Every property on the generated model and request types carries the API
  reference's description as a JSDoc comment, so an editor shows what a field
  means. No type or behaviour changed.

## [1.0.0] - 2026-10-14

The first stable release. From here on the package follows semantic
versioning: nothing in a 1.x release breaks code written against an earlier
1.x. Getting there took a deliberate break from 0.x, and every breaking change
is listed under **Upgrading from 0.x** below with the code before and after.

### The 1.0 API contract

The API froze its `/v1` contract for 1.0; these are the parts a caller sees.

- Request validation is a `400` everywhere (`InvalidRequestError`); the API no longer
  answers `422`, though one would still map to `InvalidRequestError`.
- New error codes in `APIErrorDetail.code`: `parameter_unknown` (an unknown body
  field or query parameter, named in `param`), `route_not_found` (404),
  `method_not_allowed` (405), `state_conflict` (409, replacing a 400
  `parameter_invalid` for a state refusal such as pausing a canceled
  subscription; `reason` is unchanged) and `mode_mismatch` (403).
- An unmatched route is a 404 with type `invalid_request_error` and code
  `route_not_found`; the status still picks the class, so it is the
  not-found error.
- A checkout session's `object` is `checkout.session` (was
  `checkout_session`).
- `subscriptions.createUsageRecord` is answered with `200` (was `201`); the return value is
  unchanged.
- API key, audit log and webhook delivery ids are prefixed: `ak_`, `al_`,
  `whd_`.
- `next_charge_amount_cents` is filled on subscription list, retrieve and
  mutation responses and on every `subscription.*` webhook, not only on
  retrieve.
- `expand` needs the expanded resource's read scope; without it the call
  is a `403 insufficient_scope` with `param` `expand`.
- The console-only home metrics route is not in the public document, so no
  `HomeMetrics` or `MetricPoint` type is generated for it.
- A `402` provider refusal has type `payment_error` and code
  `payment_refused` (both new in `APIErrorType` / `APIErrorCode`); `reason`
  stays `payment_refused`. It is a `PaymentError` as before.
- A missing required field is a `400 parameter_missing` naming the field in
  `param`, rather than `parameter_invalid`.
- `refunds.create` answers a refusal that is about the payment's state, not
  the request, with `409 state_conflict` (`ConflictError`): a one-off payment
  that is unpaid, past its refund window or has refunds disabled, a
  subscription with no recorded payment, and one that is no longer being
  canceled. An amount above what is left is still a `400`.
- Every operation documents a `500` with the error envelope.
- Renamed, in requests, responses and webhooks alike:
  `CreateCheckoutSessionParams.method` and `CheckoutSession.method` are
  `payment_method`; `CreateOneShotPaymentParams.method` and
  `OneShotPayment.method` are `payment_method`; `Dispute.reversed` is
  `reversed_at`; `CreateCustomerParams.test_clock` and `Customer.test_clock`
  are `test_clock_id`.
- List filters that take several values are arrays, sent comma-joined:
  `subscriptions` `status` and `renewal_state`, `disputes` `status`, and
  `events` `type`, which now matches any of several event types. The
  `invoices` and `oneShotPayments` `status` filters type their closed set
  of values.
- `customers.purge` resolves to `PurgedResource<"customer">`,
  `{ id, object: "customer", deleted: true, purged: true }`, not the
  customer: a purged customer 404s afterwards, like a deleted one.
- A coupon's `percent_off` is more than 0 and at most 100 with up to two
  decimal places, so it can read back as `12.5`.
- `OneShotPayment.metadata` is always an object (`{}` when empty), never
  `null`.
- `BillingPortalSession.subscription_id` and
  `BillingPortalSessionRevocation.subscription_id` are nullable.
- `invoice.*` events carry the invoice's real `lines`.
- `Invoice.status` has no `draft`; an invoice is issued `open`, and
  `status: "draft"` on `invoices.list` is a `400`.
- `ProviderPayload` gains `redacted`, `true` when the customer was purged
  and the stored provider payload erased.

### Hardening

- `verifyWebhookSignature` throws a `RangeError` for a `toleranceSeconds`
  that is not a finite number of seconds, 0 or more. `NaN` compared false
  against every timestamp and so accepted a replay of any age.
- A path id of `.` or `..` is refused with a `TypeError` before any request.
  Percent-encoding leaves both alone and the URL parser resolved them as dot
  segments, so `customers.retrieve("..")` requested `GET /v1/`.
- The README's typed-response example reads `sub.price?.amount_cents`.

### Added
- **Typed responses.** Every method resolves to a plain object typed from the
  API's public OpenAPI document (`Customer`, `Subscription`,
  `ListResponse<Invoice>`, ...), all exported. The types are generated by
  `scripts/generate-types.mjs`, and a test fails when they drift from the spec.
  Enum-like fields are open (`"active" | ... | (string & {})`): a value the API
  adds later is neither a type error nor a runtime one, and unknown fields pass
  through untouched.
- **Typed webhook events.** `WebhookEvent` is a union of every event this SDK
  version knows, discriminated on `type`, with `data` typed per event and
  `previous_attributes` always present (`null` when nothing changed).
  `WebhookEventMap` maps each type to its body. `verifyWebhookSignature`
  returns `WebhookEvent | UnknownWebhookEvent` by default, because a newer API
  can deliver a type this version does not name; `isKnownEventType(event)`
  narrows to `WebhookEvent`. New event types are additive in 1.x, so an
  exhaustive `never` check over `event.type` is not supported.
- **Request options** on every method, as the last argument:
  `idempotencyKey`, `timeout`, `maxRetries`, `headers` and an `AbortSignal` as
  `signal`. An aborted call is never retried and rejects with the signal's
  reason. Client options gain `maxRetries`.
- `APITimeoutError` (extends `APIConnectionError`) for a call that ran out of
  time.
- `PaymentError` (extends `APIError`, a sibling of `InvalidRequestError`) for
  a `402`. The API answers `402` with type `payment_error` when the payment
  provider refused a charge or refund the call had to make on the spot (code
  `payment_refused`; nothing moved and nothing changed), and when your own
  account is suspended (`tenant_suspended`). In 0.x a `402` was an
  `InvalidRequestError`, which said the request was at fault when it was not.
- `EmptyParams`, the parameters type of every call the API takes no
  parameters for yet. Only `{}` fits it, and a key passed anyway is refused
  with a `TypeError` rather than dropped.
- `APIError` now carries `headers`, and every HTTP error class extends it.
- `instanceof` works across the ESM and CommonJS builds: every error class is
  branded under a `Symbol.for` key, so an application that loads both copies
  still catches what either throws. `name` is set on every instance as well.
- `customers.purge` refuses, before any request, a call without
  `{ confirmed: true }`.
- `iter()` takes exactly the parameters `list()` takes, `expand` included, and
  honours `starting_after` as the cursor to begin after.
- Every resource class (`Customers`, `Subscriptions`, ...) is exported, as a
  value, so `client.customers instanceof Customers` works in both builds.
  `scripts/check-exports.mjs` packs the tarball and fails when the bundled
  declarations name a value export the runtime module lacks.
- `DeletedResource` always carries `deleted: true`, and the three `delete()`
  methods type `object` as `"customer"`, `"test_clock"` or
  `"webhook_endpoint"`.
- `npm run check:package` runs publint and arethetypeswrong over the packed
  tarball; CI runs it on Node 22 and 24.
- `SECURITY.md` ships in the package, beside the README and licence.
- `testClocks`: `create`, `retrieve`, `advance`, `delete`, `list` and `iter` over `/v1/test_clocks`, plus `CreateCustomerParams.test_clock_id` to attach a customer to a clock. Test mode only. New exported types `CreateTestClockParams` and `AdvanceTestClockParams`.
- `EventTypes` (constants, e.g. `EventTypes.INVOICE_PAID`), the `EventType` union, `EVENT_TYPES` and `isKnownEventType()`, generated from the API's event catalogue. An unknown type is still never an error: a newer API can deliver one this list does not name.
- `previous_attributes` on a webhook delivery sits beside `data`, not inside it.
- `BillKitError.reason`, the envelope's finer-grained cause, which was only reachable through `rawBody`. A `409 operation_pending` from `subscriptions.cancel`, `pause` or `update` while a renewal payment is still settling carries `reason: "renewal_processing"`; a blank `Idempotency-Key` sent by hand is a `400 parameter_invalid` with `reason: "idempotency_key_blank"`.
- `currency` on `CreateCouponParams` (the currency of a `fixed_cents` discount and of `min_amount_cents`; required with either when the account has several currencies) and on `ValidateCouponParams`, where a coupon in another currency comes back `valid: false` with `reason: "coupon_currency_mismatch"`.

### Changed
- Response fields the API always sends are required in the generated types
  (`customer_email: string | null`, not `customer_email?: string | null`), so
  a field that is present but null no longer reads as possibly missing.
- A 2xx response whose body is not JSON (or is empty) throws an `APIError`
  instead of resolving to `undefined`.
- An `idempotencyKey` left in the parameters, a key in the request options
  that is not an option (so a superset object is refused too), and
  `pageSize` in `iter()` are refused with a `TypeError` naming the fix,
  before any request. A key whose value is `undefined` counts as absent, so
  `{ ...options, idempotencyKey: undefined }` is fine.
- An unknown client option is refused with a `TypeError`; `timeoutMs` says to
  use `timeout` (milliseconds).
- **Every method that takes an id (and every `tenant` read, `tenant.export`
  and `webhookEndpoints.listEventTypes`) has a parameters slot before its
  request options**: `cancel(id, params?, options?)`, as `retrieve` on
  products, subscriptions, invoices and payments already was. The calls the
  API takes no parameters for yet type it as `EmptyParams`. Without the slot,
  the first parameter the API added to one of these calls would have needed a
  new major. A request option passed where the parameters go is refused with a
  `TypeError` naming the fix, and so is one inside real parameters
  (`products.retrieve(id, { timeout })`), which used to be sent as a query
  parameter and ignored.
- `apiKey: ""` (or a blank string) is refused at construction. It used to fall
  back to `BILLKIT_API_KEY` silently, so a client meant to have no key ran with
  whatever key the environment held. Only an absent `apiKey` reads the
  environment now.
- Every optional field of every params type also accepts `undefined`, so
  forwarding your own optional value compiles under
  `exactOptionalPropertyTypes`. The type tests compile with that flag on.
- `package.json` is in the `exports` map, so `require("@billkit-eu/sdk/package.json")`
  resolves.
- Request `headers` cannot set `Authorization`, `Idempotency-Key`,
  `Content-Type` or `User-Agent` (in any case), and every value must be a
  string; `idempotencyKey` is how to choose the key.
- A `tenant.export()` body that fails after the headers errors the stream
  with an `APIConnectionError` (the runtime's `TypeError: terminated` on
  `cause`) instead of a bare `TypeError`. There is no timeout once the
  headers are in; pass a `signal` to bound the read.
- The error brand key is versioned by major, so an error from a future 2.x
  copy does not pass a 1.x `instanceof`.
- The error `type` for a status with no envelope now uses the API's own
  vocabulary: `not_found_error` for a 404 and `conflict_error` for a 409.
- `engines.node` is `>=22` and the build targets Node 22.

### Removed
- `webhookEndpoints.getDelivery` (deprecated; use `retrieveDelivery`), `paginate`, `PaginateOptions`, `ListParams` and
  `ListResponseEnvelope` (use `ListResponse`).
- `ExpandOptions` (`expand` is a field of each method's parameters) and
  `IdempotencyOptions` (use `RequestOptions`).
- The `nowMs` option of `verifyWebhookSignature`. It let any caller move the
  replay window's clock; the function reads the real one.

### Fixed
- `verifyWebhookSignature` refuses, as a `WebhookVerificationError` and
  before any HMAC is computed, an empty or whitespace-only `secret` (an unset
  environment variable read with `!` used to verify a signature anyone could
  compute with a blank key) and a `payload` that is not a string or
  `Uint8Array` (a parsed body or `undefined` threw a raw `RangeError` or
  `TypeError`). A `t=` that is not 1 to 12 digits is malformed: `parseInt`
  read `t=1e9` as 1 and accepted `t=+1800000000`.
- A `501 Not Implemented` is no longer retried. Every other 5xx still is.
- A blank or whitespace-only `idempotencyKey` is now treated as unset and replaced with a generated key. It used to send no `Idempotency-Key` at all while the SDK still retried the POST, so a retried create could run twice.
- A non-string `idempotencyKey` no longer throws `supplied.trim is not a function`. A number or bigint (a plain-JS order id) is sent as its decimal string, as in 0.9.0, and `null` generates a key. A boolean, an object or `NaN` rejects with a `TypeError` before any request, because sending `true` or `[object Object]` would give unrelated calls the same key.
- JSON calls no longer follow redirects. A `3xx` used to be followed, re-sending the method, the JSON body and the `Idempotency-Key` to the `Location` target and returning that host's answer as success. It now throws `InvalidRequestError`, as python and php already did. The invoice and credit-note PDF calls still follow the storage redirect.
- `expand: []` sends no `expand` at all. It sent `expand=`, which the API
  refuses with a 400.
- An empty or whitespace-only id (`customers.retrieve("")`) now rejects with a `TypeError` before any request, instead of calling `/v1/customers/`. It is a rejected promise rather than a synchronous throw, so `.catch()` sees it like any other failure.
- CommonJS consumers get CommonJS type declarations. `exports` pointed both `import` and `require` at `index.d.ts`, so a TypeScript project with `module: node16` and no `"type": "module"` failed with TS1479. `require` now resolves `index.d.cts`.

### Upgrading from 0.x

**Drop the response generics.** They were assertions; the types now come from
the spec. Keep one only to narrow further.

```ts
// 0.x
const customer = await client.customers.retrieve<{ id: string; email: string }>(id);
// 1.0
const customer = await client.customers.retrieve(id); // Customer
```

**`idempotencyKey` moved to the request options**, the last argument of every
method. Left in the parameters it is refused with a `TypeError`.

```ts
// 0.x
await client.refunds.create({ payment_id, idempotencyKey: `refund-${orderId}` });
await client.subscriptions.update(id, { target_price_id, idempotencyKey: "swap-1" });
// 1.0
await client.refunds.create({ payment_id }, { idempotencyKey: `refund-${orderId}` });
await client.subscriptions.update(id, { target_price_id }, { idempotencyKey: "swap-1" });
```

**Lifecycle calls take their options third.** `cancel`, `pause`, `resume`,
`reactivate`, `revoke`, `rotateSecret`, `sendEmail`, `redeliver` and `delete`
took `{ idempotencyKey }` as their second argument in 0.x. In 1.0 every
method takes its parameters second (`{}` where the API has none yet) and
request options third. TypeScript flags the old shape, and at runtime it is
refused with a `TypeError` naming the fix, before any request.

```ts
// 0.x
await client.subscriptions.cancel(sub.id, { idempotencyKey: "cancel-1" });
// 1.0
await client.subscriptions.cancel(sub.id, {}, { idempotencyKey: "cancel-1" });
await client.customers.retrieve(id, {}, { timeout: 5_000 });
```

**Client options: `timeoutMs` is `timeout`.** `maxRetries` is new.

```ts
// 0.x
new BillKit({ timeoutMs: 10_000, retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 2 } });
// 1.0
new BillKit({ timeout: 10_000, maxRetries: 1 });
```

**Error classes.** `ResourceMissingError` is `NotFoundError`, `PermissionError`
is `PermissionDeniedError`. Every HTTP error class now extends `APIError`
(in 0.x only `ServerError` did), and a timeout is `APITimeoutError`, a subclass
of `APIConnectionError`. `WebhookVerificationError` extends `BillKitError`.
The fields (`statusCode`, `type`, `code`, `param`, `reason`, `requestId`,
`rawBody`) moved from `BillKitError` to `APIError`, since a connection error
has none of them.

```ts
// 0.x
if (err instanceof ResourceMissingError) return null;
if (err instanceof BillKitError) log(err.statusCode);
// 1.0
if (err instanceof NotFoundError) return null;
if (err instanceof APIError) log(err.statusCode);
```

**`iter()` takes `list()`'s parameters; `pageSize` is `limit`.**

```ts
// 0.x
client.events.iter({ type: "invoice.paid", pageSize: 100 });
// 1.0
client.events.iter({ type: ["invoice.paid"], limit: 100 });
```

**`customers.purge` needs an explicit confirmation.** 0.x sent
`confirmed: true` on your behalf, so the API's guard was met by a call that
never asked anyone.

```ts
// 0.x
await client.customers.purge(id);
// 1.0
await client.customers.purge(id, { confirmed: true });
```

**Tenant getters are `retrieve*`.**

```ts
// 0.x
await client.tenant.capabilities();
await client.tenant.billingProfile();
await client.tenant.portalBranding();
// 1.0
await client.tenant.retrieveCapabilities();
await client.tenant.retrieveBillingProfile();
await client.tenant.retrievePortalBranding();
```

**`tenant.export()` streams.** It resolves to a `ReadableStream<Uint8Array>`
rather than an `ArrayBuffer`, so a large account no longer has to fit in
memory.

```ts
// 0.x
await writeFile("export.json", Buffer.from(await client.tenant.export()));
// 1.0
await pipeline(Readable.fromWeb(await client.tenant.export()), createWriteStream("export.json"));
```

**Coupons and price tiers follow API 1.0.** A coupon's amount is `percent_off`
or `amount_off_cents`; `discount_type` is optional and `"fixed_cents"` is
`"fixed_amount"`. A tier's `unit_amount` and `flat_amount` are
`unit_amount_cents` and `flat_amount_cents`, and the input type is
`PriceTierParams` (`PriceTier` is now the tier a price comes back with).

```ts
// 0.x
await client.coupons.create({ code: "TEN", discount_type: "percent", discount_value: 10 });
tiers: [{ up_to: 1000, unit_amount: 1 }, { up_to: "inf", flat_amount: 500 }]
// 1.0
await client.coupons.create({ code: "TEN", percent_off: 10 });
tiers: [{ up_to: 1000, unit_amount_cents: 1 }, { up_to: "inf", flat_amount_cents: 500 }]
```

**Renamed fields and array filters follow API 1.0.**

```ts
// 0.x
await client.checkoutSessions.create({ price_id, customer_id, success_url, cancel_url, method: "ideal" });
await client.customers.create({ email, test_clock: clock.id });
await client.subscriptions.list({ status: "active,past_due" });
dispute.reversed;
const customer = await client.customers.purge(id, { confirmed: true }); // the customer
// 1.0
await client.checkoutSessions.create({ price_id, customer_id, success_url, cancel_url, payment_method: "ideal" });
await client.customers.create({ email, test_clock_id: clock.id });
await client.subscriptions.list({ status: ["active", "past_due"] });
dispute.reversed_at;
const marker = await client.customers.purge(id, { confirmed: true }); // { id, object, deleted, purged }
```

**Webhooks.** `verifyWebhookSignature` returns `WebhookEvent |
UnknownWebhookEvent`; narrow with `isKnownEventType(event)`, then on `type`. The 0.x generic interface `WebhookEvent<TData>` is gone, and so is the
`nowMs` option. `previous_attributes` is always present and `null` when
nothing changed, where 0.x documented it as absent.

```ts
// 0.x
const event = await verifyWebhookSignature<WebhookEvent<{ id: string }>>({ payload, signatureHeader, secret });
if (event.previous_attributes) { /* ... */ }
// 1.0
const event = await verifyWebhookSignature({ payload, signatureHeader, secret });
if (isKnownEventType(event) && event.type === "subscription.updated" && event.previous_attributes !== null) { /* ... */ }
```

**Removed exports.** `getDelivery` is `retrieveDelivery`. `paginate` and
`PaginateOptions` are gone (use `iter()`). `ListParams` is `BaseListParams`,
and `ListResponseEnvelope<T>` is `ListResponse<T>`. `ExpandOptions` is gone
(`expand` is in each method's parameters), and `IdempotencyOptions` is
`RequestOptions`.

**A 2xx that is not JSON throws.** It resolved to `undefined` in 0.x; it is an
`APIError` with the text on `rawBody` now. It usually means `baseUrl` points
at something other than the API.

**Node 22 or newer.**

**An empty `apiKey` throws at construction.** `new BillKit({ apiKey: "" })`
(or a blank string) used to fall back to `BILLKIT_API_KEY`; it now throws, and
so does a client built with no key anywhere. The throw happens wherever the
client is constructed, which matters when one object both calls the API and
verifies webhooks: built eagerly at module load, a missing key now takes the
webhook route down with it, although verification only ever needed the signing
secret. One integration answered every delivery with a 500 instead of a 401
that way. `verifyWebhookSignature` needs no client, so construct the client
lazily, on first use, and pass `undefined` (or leave `apiKey` out) to read
`BILLKIT_API_KEY` rather than `process.env.BILLKIT_API_KEY ?? ""`:

```ts
// 0.x: an unset variable fell through to the environment, or failed per call
const client = new BillKit({ apiKey: process.env.BILLKIT_API_KEY ?? "" });
// 1.0: leave the key out to read BILLKIT_API_KEY, and build the client where it is used
let client: BillKit | undefined;
const billkit = () => (client ??= new BillKit());
```

## [0.9.0] - 2026-10-09

### Added
- Embedded one-off payments: `CreateOneShotPaymentParams.ui_mode` (`"hosted"` | `"embedded"`). Sent as `"embedded"` without `method`, `oneShotPayments.create` creates no provider payment yet and returns a short-lived `client_secret` (with a null `redirect_url`) for the browser payment element in `@billkit-eu/js` / `@billkit-eu/react`, where the payer picks the method. Events, refunds and the payment id work as for a hosted one-shot. **Requires the matching API release.**

### Changed
- `CreateOneShotPaymentParams.method` is now optional in the type, because an embedded one-shot must omit it. A hosted one-shot still needs it and the API refuses the call without it.

## [0.8.1] - 2026-09-26

### Changed
- `UpdateCouponParams.applies_to_price_ids` (`null` lifts the price restriction), `UpdateCouponParams.min_amount_cents` (`null` lifts the minimum), `UpdateProductParams.marketing_features` (`null` empties the list) and `UpdatePriceParams.refund_window_initial_days` / `refund_window_renewal_days` (`null` drops the price's override) now accept `null`, sent as a JSON null. The request already carried a `null` through; the types refused it. Every other update field stays typed without `null`.
  **Upgrade note:** as in 0.8.0, a null passed through from your own data clears the field: `coupons.update(id, { min_amount_cents: row.min })` with `row.min` sometimes `null` now lifts the coupon's minimum, which widens who can redeem it. Omit the field when you mean "leave it".
  **Requires the matching API release.** An older API accepts the null on `applies_to_price_ids`, `min_amount_cents` and `marketing_features` and leaves the value in place.
- Every other update field refuses an explicit null with a `400` naming the field (the API used to ignore it). The SDK never sends one there; omit the field to leave it unchanged.

## [0.8.0] - 2026-09-26

### Added
- `oneShotPayments.list(params)` and `oneShotPayments.iter(options)` for `GET /v1/checkout/one_shot`, newest first, filtered by `customer_id` and `status`. New exported type `OneShotPaymentsListParams`.
- `payments.retrieve` documents the `refund_eligibility` expansion: `{ object, eligible, amount_cents, currency, days_remaining, window_ends_at, reason }`, whether a refund of the remaining balance would succeed now. It is retrieve-only; `payments.list` refuses it.

### Changed
- An explicit `null` now clears `UpdateProductParams.description`, `UpdateCustomerParams.name`, `UpdateWebhookEndpointParams.description`, `UpdateCouponParams.max_redemptions` and `redeem_by`, and `UpdateTaxRateParams.display_name`. The types accept `null`, and it is sent as a JSON null rather than pruned; omitting the field still leaves it alone.
  **Upgrade note:** a `null` you pass through from your own data now clears the field. `customers.update(id, { name: user.name })` with `user.name` sometimes `null` used to leave the name alone and now erases it; pass `undefined` (or omit the key) when you mean "leave it".

## [0.7.1] - 2026-09-25

### Added
- `UpdateProductParams.default_price_id` (`string | null`) for the product's default price, the one the billing portal offers on that price's interval. It must be an active price of the same product. An explicit `null` clears it and is sent as a JSON null rather than pruned; omitting the field leaves the default alone.
- `products.retrieve` and `products.list` document the `default_price` expansion alongside `prices` and `stats`.

### Changed
- `SetTenantBillingProfileParams` documents that the tenant `vat_id` is set once: changing it or clearing it with `null` afterwards is refused with a 400 `vat_id_locked` on `vat_id` and writes nothing, and support changes it. The address fields and `registration_number` still clear with `null`.

## [0.7.0] - 2026-09-23

### Fixed
- `CreateCouponParams.discount_type` now types the API's two literals, `"percent"` and `"fixed_cents"`; it had offered `"percentage"` / `"amount"`, neither of which the API accepts.
- Every path id is percent-encoded, so an id containing `/`, `?` or `#` can no longer rewrite the request onto a different route.
- `APIConnectionError` carries the original fetch failure as `cause`, including on the timeout path, so Node's "fetch failed" no longer hides the real reason.
- `BaseListParams` lost its index signature, so a misspelled filter is a compile error instead of a query parameter the server ignores. `ListParams` stays exported as a deprecated alias.

### Added
- `apiKeys` resource: `create`, `retrieve`, `revoke`, `list`, `iter`.
- `invoices.sendEmail(id)` for `POST /v1/invoices/{id}/email`.
- `payments.retrieveProvider(id)` for `GET /v1/payments/{id}/provider`.
- `tenant.billingProfile()` / `tenant.setBillingProfile(params)` for the seller's country, VAT id and invoice address; an explicit `null` clears a field.
- `tenant.export()` returns the account's full JSON export as raw bytes.
- `webhookEndpoints.listEventTypes()` for the deliverable-event catalogue.
- `expand?: string[]` on `customers.list`, `products.list`, `subscriptions.list`, `payments.list`, `invoices.list` and `events.list`, and as an optional second argument on `products.retrieve`, `subscriptions.retrieve`, `payments.retrieve` and `invoices.retrieve`.
- `payments.list` types `customer_id`; `invoices.list` types `customer_id`, `subscription_id`, `payment_id` and `status`; `disputes.list` types `status` and `payment_id`. All are carried onto every page by `iter()`.
- `CreateCheckoutSessionParams.country`, so VAT applies to the first charge on the hosted flow.
- `CreateBillingPortalSessionParams.deliver_email`, which also emails the portal link to the customer.
- New exported types: `CreateApiKeyParams`, `SetTenantBillingProfileParams`, `ExpandOptions`, `DisputesListParams`, `InvoicesListParams`, `PaymentsListParams`, `ProductsListParams`, `SetCustomerVatNumberParams`, `UpdatePriceParams`.

### Changed
- `UpdatePriceParams` accepts every field `PriceUpdate` does (`active`, `metadata`, `tax_behavior`, `payment_methods`, `refund_on_cancel`, `refund_window_initial_days`, `refund_window_renewal_days`), all optional, where `active` was previously required and alone.
- `SetCustomerVatNumberParams.vat_number` is `string | null`; an explicit `null` clears the registration and is not pruned.
- `billingPortalSessions.create` prunes undefined fields instead of sending a fixed body.

## [0.6.0] - 2026-09-23

### Added
- **`eps` and `paypal` can now start a subscription**, not just take a one-off
  charge. Both are accepted wherever a payment method is named: the
  `checkoutSessions.create` `method` union, a price's `payment_methods`
  allowlist, and the one-shot union.
  - **EPS** mints a *SEPA* mandate, exactly as iDEAL does, so the subscription
    renews on `directdebit`.
  - EPS is **Austria-only** and carries a **EUR 1.00 minimum**, a hundred
    times iDEAL's. A fully-discounted first charge on a price offering it is
    raised to that floor.
  - **PayPal** mints a `paypal` mandate and renews on itself. No country
    restriction.
  - `bancontact` stays one-off only: Mollie's recurring guide and its
    Bancontact method page disagree about whether it mints a mandate, and that
    is being settled against a live profile rather than guessed.

- **`banktransfer` joins the `oneShotPayments.create` method union.** One-off
  only, for the same reason `bancontact` is.
  - It mints no mandate, so it can neither anchor a subscription nor settle a
    metered cycle. Mollie refuses it at `sequenceType=first` with "The payment
    method does not support sequence type", which is why the checkout union
    stays narrower than the one-shot one rather than the two converging.
  - **It settles in days, not seconds.** The payer is handed bank details and
    pays on their own schedule, so Mollie holds the payment `open` for about a
    fortnight and `expires_at` comes back roughly 13 days out.
  - A pending bank transfer is **not a failure and not something to poll**:
    wait for `one_shot_payment.succeeded` / `.failed`.
  - Nothing expires early: the server's reaper keys on the `expires_at` copied
    from Mollie's own answer, not on a BillKit-invented window.
  - Minimum is EUR 0.01, measured against a live profile rather than read off
    a page.

- **`resource_id` filter on `auditLogs.list()` and `auditLogs.iter()`.**
  - It answers "everything that ever happened to this customer", which is the
    question an audit log mostly exists for.
  - The API has always accepted it; this SDK named three of its four filters
    and omitted this one.
  - Matches exactly, and combines with `resource_type` rather than replacing
    it.

## [0.5.0] - 2026-09-22

### Changed
- `webhookEndpoints.getDelivery()` is now `retrieveDelivery()`. Every other
  single-row fetch in every BillKit SDK is `retrieve`, and python and php
  already spelled this one `retrieve_delivery` / `retrieveDelivery`, so node
  was the outlier and the obvious name was a type error. `getDelivery` stays as
  a deprecated alias (removing it would break callers over a naming
  preference) and goes in the next major.

### Fixed
- `CustomerListParams` is exported from the package entry point. The interface
  documented the `provisional` filter but could not be imported, so callers
  building the params object ahead of the call had nothing to type it with.

## [0.4.0]

### Added
- **`creditNotes`**: `retrieve`, `list`, `iter` and `retrievePdf`. A credit
  note is the document that reverses an issued invoice; one is created for you
  when a refund settles, so there is no `create` here. `list` takes
  `invoice_id` to answer "was this sale credited, and by how much".
- **`invoices.void(id)`** records that an invoice was never owed. It keeps
  its number and stays readable; it just stops being a receivable.

  A **paid** invoice is refused with a `ConflictError` whose `code` is
  `"invoice_not_voidable"`. Once the money has moved, "never owed" is not
  true: refund the payment instead, and a credit note is issued when the
  refund settles. Voiding twice is a no-op.

## [0.3.0]

### Added
- **Metered pricing below one minor unit.** `prices.create` takes
  `unit_amount_decimal`: a per-unit rate in **minor units** with up to 12
  decimal places, so `"0.02"` (0.02 cents, i.e. EUR 0.0002 per unit) is finally
  expressible. `amount_cents` is an integer and could never say it. Metered
  prices only.

  It is typed as a `string`, so a `number` is a compile error. A number is also
  refused at runtime with a `TypeError`, for the callers the type system cannot
  reach: plain JavaScript, a value that came through `any`, a parsed JSON body.
  A double cannot hold 0.0002 exactly, so accepting one would work for the rates
  that happen to round-trip and silently mis-price the ones that do not.
- **Tiered pricing.** `prices.create({ billing_scheme: "tiered", tiers_mode,
  tiers })`, with the new exported `PriceTier` type. `tiers_mode: "graduated"`
  prices the units inside each band; `"volume"` lets the period total pick one
  band which then prices every unit. The same table under the two modes is a
  different bill, so the mode is required rather than defaulted. The last band
  must be `up_to: "inf"`. Each band's `unit_amount_decimal` gets the same
  string-only treatment.
- **`identifier` on `subscriptions.createUsageRecord`**, for the retry an
  `Idempotency-Key` cannot catch. The key covers a retry of one HTTP request;
  `identifier` covers a retry of *your own* call (a job runner replaying a
  task, a queue delivering twice), which arrives as a genuinely new request with
  a new key. It is unique within the subscription, and a second report of the
  same identifier returns the first record unchanged rather than billing twice.
  If your reporting pipeline is at-least-once, this is the one that matters.
- **`subscriptions.retrieveUsageSummary(id)`**, the money view of pending usage:
  `pending_quantity`, `net_cents` / `tax_cents` / `gross_cents` computed through
  the same rate or tier table the period close uses, and `will_charge`. Read
  `will_charge` before promising a customer an amount: a period under
  `minimum_charge_cents` (EUR 1.00) is **not** charged, because the provider
  would refuse it, and the usage rolls into the next period instead. Previously
  the only record of that decision was a server log line. `open_invoice_id`
  names an earlier cycle still unsettled.
- **`refund_on_cancel` on `prices.create`.** Server-side since the `0066`
  migration and unreachable from this SDK until now. `"full"` or `"prorated"`
  issues the refund a cancellation promised without anyone having to remember
  to. Metered prices must leave it at `"none"`.

### Changed
- `CreatePriceParams.amount_cents` is now **optional**, because a price can be
  priced by `unit_amount_decimal` or by `tiers` instead. Exactly one of the
  three is required, and the server refuses a price with none of them. Existing
  calls are unaffected.
- `prices.create` is now `async`. It was already `Promise`-returning, but the
  new rate guard throws, and a synchronous throw out of a method typed
  `Promise<T>` escapes `.catch()`, so the throw is delivered as a rejection
  instead, and one error path handles both.

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
  update route instead: `active: false` for products, prices, tax rates and
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

[1.0.0]: https://github.com/billkit-eu/billkit-node/compare/v0.9.0...v1.0.0
[0.9.0]: https://github.com/billkit-eu/billkit-node/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/billkit-eu/billkit-node/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/billkit-eu/billkit-node/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/billkit-eu/billkit-node/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/billkit-eu/billkit-node/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/billkit-eu/billkit-node/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/billkit-eu/billkit-node/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/billkit-eu/billkit-node/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/billkit-eu/billkit-node/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/billkit-eu/billkit-node/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/billkit-eu/billkit-node/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/billkit-eu/billkit-node/releases/tag/v0.1.0
