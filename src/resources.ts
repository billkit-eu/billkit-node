/**
 * Resource accessors mirroring the BillKit API surface.
 *
 * Each resource exposes the public verbs from `/v1/<resource>`. The
 * return type defaults to `unknown`; the SDK doesn't ship runtime
 * schemas (zod / valibot) because the API is Stripe-shape and tenants
 * typically forward the JSON through their own data layer unchanged.
 * Callers who want strong types parameterise each call with their
 * own generic:
 *
 *     interface Customer { id: string; email: string }
 *     const c = await client.customers.create<Customer>({ email: "..." });
 *
 * Every list-returning resource also exposes an `iter()` method that
 * walks every page via the Stripe-shape `has_more` + `starting_after`
 * cursor protocol. Iterate with `for await`:
 *
 *     for await (const customer of client.customers.iter()) { ... }
 */

import { paginate, type ListResponseEnvelope } from "./pagination.js";
import type { Transport } from "./transport.js";

// ─── Shared parameter shapes ───────────────────────────────────────

/**
 * Cursor-pagination knobs shared by every `list()` method.
 *
 * Closed on purpose: there is no index signature, so a misspelled filter
 * (`provisonal`) is a compile error instead of a query parameter the
 * server ignores. The Transport takes `query` as a plain `object` and
 * prunes/stringifies it, which is what lets these interfaces through
 * without a cast.
 */
export interface BaseListParams {
  limit?: number;
  starting_after?: string;
  // Deliberately no `ending_before`: BillKit's cursor pagination binds
  // `limit` + `starting_after` only (see `api/billkit/api/pagination.py`).
  // Advertising a backwards cursor the server ignores is worse than not
  // having one — the request succeeds and silently re-serves page 1.
}

/**
 * `?expand=` on a single-object GET. The relations a route accepts differ
 * per resource and are listed on each `retrieve()`; an unknown one is a
 * `400` naming the ones that work.
 */
export interface ExpandOptions {
  expand?: string[];
}

/**
 * `prices.list` params. Adds the server-side `product_id` filter on top of
 * the usual cursor knobs. `GET /v1/prices?product_id=...` narrows to one
 * product's prices, which beats listing everything and filtering client-side
 * once a tenant has more than a page of prices.
 */
export interface PricesListParams extends BaseListParams {
  product_id?: string;
}

/**
 * `payments.list` params. `customer_id` narrows to one customer's
 * charges. Mandate verifications are never listed, so every row is a
 * real purchase attempt; check `status` before treating one as revenue.
 */
export interface PaymentsListParams extends BaseListParams {
  customer_id?: string;
  /** Expandable here: `customer`, `subscription`. */
  expand?: string[];
}

/**
 * `invoices.list` params. The three id filters each narrow to one row's
 * worth of invoices: `payment_id` answers "which invoice did this charge
 * produce".
 */
export interface InvoicesListParams extends BaseListParams {
  customer_id?: string;
  subscription_id?: string;
  payment_id?: string;
  /** One of `draft`, `open`, `paid`, `void`, `uncollectible`. */
  status?: string;
  /** Expandable here: `customer`. */
  expand?: string[];
}

/**
 * `disputes.list` params. `status` takes a comma-separated list of `open`
 * / `won`. There is no `lost`, because the provider gives no signal for
 * one. `payment_id` matches subscription payments only, not one-off
 * charges.
 */
export interface DisputesListParams extends BaseListParams {
  status?: string;
  payment_id?: string;
}

/**
 * `subscriptions.list` params. Both filters take a comma-separated
 * list (`"active,past_due"`); an unrecognised value is rejected with
 * `400 parameter_invalid` rather than silently ignored.
 *
 * The two answer different questions, and mixing them up is the most
 * common mistake against this route. `status` is where the subscription
 * stands with its payments. `renewal_state` is what happens at the end
 * of the current period. A paused subscription keeps `status: "active"`,
 * because the customer has paid for the period they are in, so
 * `renewal_state: "paused"` is the only way to find paused ones —
 * `status: "paused"` is not an accepted value and is rejected.
 */
export interface SubscriptionsListParams extends BaseListParams {
  customer_id?: string;
  /** `incomplete` | `trialing` | `active` | `past_due` | `canceled`, CSV. */
  status?: string;
  /** `auto_renew` | `paused` | `canceling` | `stopped`, CSV. */
  renewal_state?: string;
  /** Expandable here: `customer`, `price`, `refund_eligibility`. */
  expand?: string[];
}

/** Optional idempotency knob carried by every mutating call. */
export interface IdempotencyOptions {
  /** Coalesces retries across process restarts. The SDK generates
   *  a random `sdk-<uuid>` key for every mutating call if you don't
   *  supply one. Pass your own when you want retries from a different
   *  process to converge on the same server-side result. */
  idempotencyKey?: string;
}

/**
 * @deprecated Alias of {@link BaseListParams}, kept for callers that
 * imported the older name. Reach for the resource-specific `*ListParams`
 * (e.g. `EventsListParams`) instead.
 */
export type ListParams = BaseListParams;

// ─── Per-resource parameter shapes ─────────────────────────────────
//
// We keep one exported interface per public surface so callers can
// import the shape, build it ahead of time, and pass it in. Inlined
// shapes were inconsistent across resources; the named-interface
// form is greppable and survives editor "go to definition".

export interface CreateCustomerParams extends IdempotencyOptions {
  email?: string;
  name?: string;
  country_code?: string;
  metadata?: Record<string, string>;
}

export interface UpdateCustomerParams extends IdempotencyOptions {
  email?: string;
  name?: string;
  country_code?: string;
  metadata?: Record<string, string>;
}

/** Query parameters accepted by `GET /v1/customers`. */
export interface CustomerListParams extends BaseListParams {
  /**
   * `false` for customers who have paid, `true` for abandoned checkouts,
   * omitted for both.
   */
  provisional?: boolean;
  /** Expandable here: `stats`. Sent as `expand=a,b`. */
  expand?: string[];
}

/** Query parameters accepted by `GET /v1/products`. */
export interface ProductsListParams extends BaseListParams {
  /** Expandable here: `prices`, `stats`. */
  expand?: string[];
}

/**
 * Body for `POST /v1/customers/{id}/vat_number`. The VAT number is
 * sent through VIES server-side; the response carries
 * `vat_number_validated` reflecting the outcome.
 *
 * `vat_number: null` **clears** the registration, and is sent as an
 * explicit null rather than pruned: only `undefined` is dropped.
 */
export interface SetCustomerVatNumberParams extends IdempotencyOptions {
  vat_number: string | null;
  /** VIES needs a country; send it when the customer has none yet. */
  country_code?: string;
}

/**
 * Body for `POST /v1/customers/{id}/purge`. The server requires
 * `confirmed: true` as a fat-finger guard against accidental purges
 * fired from a DELETE that meant to soft-delete. The SDK defaults
 * `confirmed` to `true` so the caller doesn't have to opt in twice.
 */
export interface PurgeCustomerParams extends IdempotencyOptions {
  confirmed?: boolean;
}

export interface CreateProductParams extends IdempotencyOptions {
  /** Customer-facing name, for example "Pro" or "Enterprise". */
  name: string;
  /** Optional long-form description shown in your own catalog UI. */
  description?: string;
  /** Ordered bullets suitable for pricing tables and checkout pages. */
  marketing_features?: string[];
  /** Small string metadata map echoed back on the Product object. */
  metadata?: Record<string, string>;
  /**
   * Let a *buyer* type a coupon code at the embedded checkout for this
   * product. Defaults to `false`. A coupon you apply yourself by passing
   * `coupon_code` when you create a Checkout Session is unaffected — that
   * is you discounting your own sale, and it has never needed this flag.
   *
   * The code is redeemed only once the payment settles, so a shopper who
   * tries a single-use code and abandons the checkout does not use it up.
   */
  allow_promotion_codes?: boolean;
}

export interface UpdateProductParams extends IdempotencyOptions {
  name?: string;
  description?: string;
  marketing_features?: string[];
  metadata?: Record<string, string>;
  /** Set false to stop selling a product without deleting history. */
  active?: boolean;
  /** See {@link CreateProductParams.allow_promotion_codes}. */
  allow_promotion_codes?: boolean;
}

/**
 * Body for `POST /v1/prices/{id}`. Every field is optional; omitted ones
 * are left alone.
 *
 * The dividing line is what a field decides. `amount_cents`, `currency`,
 * `interval` and `usage_type` decide **what a past charge was**, so they
 * are fixed at creation and absent here, because subscriptions renew
 * against a price by id and editing one would re-price live customers.
 * Everything
 * below decides **what happens next**, which is why it is editable:
 * setting `refund_on_cancel` covers the customers already on the price.
 *
 * `tax_behavior` is the exception and moves one way. It can be set while
 * the price is still `"unspecified"` and never changed again, because
 * flipping it would restate whether tax was inside or on top of an amount
 * somebody has already paid.
 */
export interface UpdatePriceParams extends IdempotencyOptions {
  /** `false` withdraws the price from sale, `true` puts it back. */
  active?: boolean;
  metadata?: Record<string, string>;
  /** Settable once, while the price is still `"unspecified"`. */
  tax_behavior?: "inclusive" | "exclusive";
  /** Read when a checkout opens. At least one entry. */
  payment_methods?: Array<
    "creditcard" | "directdebit" | "ideal" | "eps" | "applepay" | "paypal" | (string & {})
  >;
  refund_on_cancel?: "none" | "full" | "prorated";
  /** `0` disables refunds for that charge type; `N > 0` is an N-day window. */
  refund_window_initial_days?: number;
  refund_window_renewal_days?: number;
}

/**
 * One band of a tiered price.
 *
 * `up_to` is inclusive, and the **last band must be `"inf"`** because a
 * bounded top band cannot price the usage above it. Bands must strictly
 * increase.
 *
 * A band names a unit rate (`unit_amount` in whole minor units, or
 * `unit_amount_decimal` for a finer one), a `flat_amount` charged once for
 * reaching the band, or both. Write a free band as `unit_amount: 0` rather
 * than by omitting the rate, so "free" is something the price says instead
 * of something it forgot.
 */
export interface PriceTier {
  up_to: number | "inf";
  /** Whole minor units per unit in this band. */
  unit_amount?: number;
  /**
   * A rate finer than one minor unit, **as a string** — see
   * {@link CreatePriceParams.unit_amount_decimal} for why it is never a
   * `number`.
   */
  unit_amount_decimal?: string;
  /** Charged once when the usage reaches this band. Whole minor units. */
  flat_amount?: number;
}

export interface CreatePriceParams extends IdempotencyOptions {
  /** Existing Product id returned from `client.products.create`. */
  product_id: string;
  /**
   * Whole minor units per period (licensed) or per unit (metered).
   *
   * Optional because a metered price can be priced by
   * {@link CreatePriceParams.unit_amount_decimal} or by
   * {@link CreatePriceParams.tiers} instead. Exactly one of the three; a
   * price with none of them is refused server-side.
   */
  amount_cents?: number;
  /**
   * A per-unit rate smaller than one minor unit, in **minor units**, to 12
   * decimal places. `"0.02"` is 0.02 cents, i.e. EUR 0.0002 per unit, which
   * is the canonical per-API-call price and not expressible as an integer.
   * Metered prices only.
   *
   * **It is a `string`, and that is load-bearing.** A JS `number` is an
   * IEEE-754 double and cannot hold 0.0002 exactly, so the rate would be
   * corrupted before it was ever multiplied by a quantity. The type forbids
   * a number at compile time, and the SDK throws a `TypeError` if an
   * untyped JavaScript caller passes one anyway.
   *
   * The period's whole quantity is multiplied by the rate and rounded
   * **once**, at the invoice.
   */
  unit_amount_decimal?: string;
  /**
   * `"per_unit"` (the default) multiplies one rate by the quantity.
   * `"tiered"` prices by bands and requires
   * {@link CreatePriceParams.tiers} and
   * {@link CreatePriceParams.tiers_mode}. Metered prices only.
   */
  billing_scheme?: "per_unit" | "tiered";
  /**
   * How a tier table is read, and there is **no default** because the same
   * table means two different bills. `"graduated"` prices the units inside
   * each band; `"volume"` lets the period total pick one band which then
   * prices every unit. 1,500 units against "first 1,000 at EUR 0.01, then
   * EUR 0.005" is EUR 12.50 graduated and EUR 7.50 by volume.
   */
  tiers_mode?: "graduated" | "volume";
  /** The band table. Required when `billing_scheme` is `"tiered"`, refused otherwise. */
  tiers?: PriceTier[];
  currency: string;
  interval: "month" | "year" | (string & {});
  metadata?: Record<string, string>;
  trial_days?: number;
  trial_verification_cents?: number;
  payment_methods?: Array<
    "creditcard" | "directdebit" | "ideal" | "eps" | "applepay" | "paypal" | (string & {})
  >;
  /**
   * What a cancellation refunds without being asked. `"none"` (the default)
   * nothing; `"full"` the whole last charge; `"prorated"` the unused part
   * of the current period. Both non-none modes also end access
   * immediately, and both stay bounded by the refund window below.
   *
   * Metered prices must leave this at `"none"`: ending access mid-period
   * would strand usage that has not been billed yet.
   */
  refund_on_cancel?: "none" | "full" | "prorated";
  /**
   * Per-Price refund-window override (`POST /v1/prices`). `undefined`
   * inherits the default policy table (7d / 30d initial, 3d renewal);
   * `0` disables refunds for that charge type; `N > 0` is an N-day
   * window (capped server-side at 365). Useful for "Pro Bundle has a
   * 14-day money back" or "Lifetime: no refunds" product decisions.
   */
  refund_window_initial_days?: number;
  refund_window_renewal_days?: number;
  /**
   * Whether `amount_cents` is quoted gross (`"inclusive"`, VAT is
   * backed out of it) or net (`"exclusive"`, VAT is added on top at
   * charge time). `undefined` inherits `"unspecified"`, which defers to
   * the tax rate configured for the buyer's country. Set it explicitly
   * when the amount you advertise has to be the amount charged,
   * regardless of what tax rates exist now or later.
   */
  tax_behavior?: "inclusive" | "exclusive" | "unspecified";
  /**
   * `"licensed"` (the default when omitted) bills `amount_cents` per
   * period regardless of consumption. `"metered"` bills **per reported
   * unit**: post consumption with `subscriptions.createUsageRecord`, and
   * at each period close BillKit invoices the period's total and charges
   * the stored mandate.
   *
   * A metered unit is priced by `amount_cents`, by `unit_amount_decimal`,
   * or by `tiers` — exactly one. Metered prices must be
   * `interval: "month"`, cannot have `trial_days`, and cannot set
   * `refund_on_cancel`.
   */
  usage_type?: "licensed" | "metered";
}

/**
 * Body for `POST /v1/subscriptions/{id}/usage_records`. Only valid
 * against a subscription whose price is `usage_type: "metered"`; the
 * server rejects a licensed subscription with `400 parameter_invalid`.
 */
export interface CreateUsageRecordParams extends IdempotencyOptions {
  /** Units consumed, `1..1_000_000`. Post multiple records to accumulate. */
  quantity: number;
  /**
   * Epoch seconds when the consumption happened. Omit to let the
   * server stamp receipt time. Useful when reporting is batched and
   * the record must land in the period the usage occurred.
   */
  occurred_at?: number;
  /**
   * Your own id for the event being metered, unique within this
   * subscription. This is the dedupe an `Idempotency-Key` cannot do.
   *
   * The key covers a retry of *one HTTP request*, including the SDK's own
   * internal retries. `identifier` covers a retry of *your* call — a job
   * runner replaying a task, a queue delivering twice, your code
   * re-invoking after its own timeout — which arrives at the API as a
   * genuinely new request with a new key. A second report of the same
   * identifier returns the first record unchanged instead of billing
   * twice.
   *
   * If your reporting pipeline is at-least-once, this is the one that
   * matters.
   */
  identifier?: string;
  /** Small string metadata map echoed back on the record. */
  metadata?: Record<string, string>;
}

/**
 * `subscriptions.listUsageRecords` params. `invoice_id` filters by
 * billing state: `"pending"` selects records not yet rolled into an
 * invoice, and a concrete `inv_...` id selects the records that
 * invoice billed. Omit it to list everything.
 */
export interface UsageRecordsListParams extends BaseListParams {
  invoice_id?: "pending" | (string & {});
}

export interface CreateCheckoutSessionParams extends IdempotencyOptions {
  /**
   * Existing Customer to attach the session to. Mutually exclusive
   * with `customer_email`; exactly one of the two must be set.
   */
  customer_id?: string;
  /**
   * Stripe-compatible shortcut: BillKit creates a fresh Customer row
   * in the same transaction as the checkout. Never dedupes by email
   * (emails are not unique identifiers in BillKit). Mutually exclusive
   * with `customer_id`.
   */
  customer_email?: string;
  /**
   * Optional friendly name carried onto the auto-created Customer when
   * using `customer_email`. Rejected with `422` if supplied alongside
   * `customer_id` (rename existing customers via `customers.update`).
   */
  customer_name?: string;
  price_id: string;
  success_url: string;
  cancel_url: string;
  /**
   * The buyer's ISO-3166-1 alpha-2 country, when you already know it.
   * Stored on the customer if they do not have one yet, which is what
   * lets VAT apply to the very first charge. On the hosted flow the buyer
   * only reaches a country-collecting page after the charge exists.
   * Never overwrites a country the customer already has.
   */
  country?: string;
  /**
   * Pin the Mollie payment method. `undefined` lets Mollie pick from
   * the customer's available methods; when set, must be in the price's
   * `payment_methods` allowlist.
   *
   * Subscription-starting only, so this is deliberately NARROWER than the
   * one-shot union: `bancontact` and `banktransfer` are absent because
   * neither can mint the mandate a renewal needs. Mollie refuses the
   * latter outright with "The payment method does not support sequence
   * type".
   */
  method?:
    | "creditcard"
    | "directdebit"
    | "ideal"
    | "eps"
    | "applepay"
    | "paypal"
    | (string & {});
  /** Optional coupon code applied at checkout; atomically claimed. */
  coupon_code?: string;
  /**
   * Per-session trial override. Replaces the price's `trial_days`
   * for this checkout. Capped server-side at `2 × max(price.trial_days, 14)`.
   * `0` disables a trial that the price would otherwise grant.
   */
  trial_days_override?: number;
  /**
   * `"hosted"` (the default) returns a `url` you redirect the buyer to.
   * `"embedded"` returns a `client_secret` instead, for
   * `mountCheckoutElement()` / `<CheckoutElement/>` from
   * `@billkit-eu/js` — the card fields then render in a cross-origin
   * iframe on your own page.
   */
  ui_mode?: "hosted" | "embedded";
  /**
   * Small string map carried onto the session. Up to 50 keys, key ≤ 40
   * chars, value ≤ 500 chars.
   */
  metadata?: Record<string, string>;
}

export interface CreateRefundParams extends IdempotencyOptions {
  payment_id?: string;
  subscription_id?: string;
  /**
   * Refund a mandate-less one-shot payment (`oneShotPayments.create`).
   * Mutually exclusive with `payment_id` / `subscription_id`; pass
   * exactly one target or the server rejects with `400`.
   */
  one_shot_payment_id?: string;
  /**
   * Partial-refund amount in minor units. Omit to refund the whole remaining
   * balance (the full charge when nothing has been refunded yet). A payment
   * may carry several partial refunds up to the charged amount; the one that
   * brings the cumulative total to the full charge cancels the bound
   * subscription (or flips a one-shot to `refunded`).
   */
  amount_cents?: number;
  reason?: string;
}

/**
 * Body for `POST /v1/checkout/one_shot`, a single mandate-less charge
 * (the Stripe PaymentIntent shape, mapped onto Mollie). No subscription,
 * no mandate, no renewals: it settles once against your `success_url`.
 */
export interface CreateOneShotPaymentParams extends IdempotencyOptions {
  /** Existing Customer to charge. */
  customer_id: string;
  amount_cents: number;
  /** ISO-4217, e.g. `"EUR"`. Validated against the tenant allowlist. */
  currency: string;
  /**
   * Concrete Mollie method to charge with. Required, because a one-shot commits
   * up front). Validated against the tenant's capability allowlist for
   * `currency`; one-off methods like `bancontact` and `banktransfer` are
   * allowed here even though they can't back a subscription.
   *
   * `banktransfer` settles in DAYS, not seconds: the payer is handed bank
   * details and Mollie holds the payment `open` for about a fortnight. Expect
   * `one_shot_payment.paid` long after the call returns.
   *
   * `giropay` was removed: the scheme shut down at the end of 2024 and the
   * server now 422s it. The `(string & {})` tail keeps this open on
   * purpose: unlike the console's read-side `PaymentMethodKind`, this is a
   * *request* type the server validates, so an SDK that lags a newly-added
   * method should not be the thing that blocks the call.
   */
  method:
    | "creditcard"
    | "directdebit"
    | "ideal"
    | "bancontact"
    | "eps"
    | "applepay"
    | "paypal"
    | "banktransfer"
    | (string & {});
  /** Where Mollie returns the payer after the hosted checkout. */
  success_url: string;
  /** Optional page for an abandoned/cancelled payment. */
  cancel_url?: string;
  /** Shown on the Mollie page + the payer's bank statement. */
  description?: string;
  /**
   * Per-payment refund-window override in days. `undefined` inherits the
   * one-shot default (30 days); `0` disables refunds for this payment;
   * `N > 0` is an N-day window (capped server-side at 365).
   */
  refund_window_days?: number;
  /**
   * Whether `amount_cents` is quoted gross or net.
   *
   * `"inclusive"` (the default when omitted) charges `amount_cents` and
   * backs the VAT out of it. `"exclusive"` reads it as a net figure and
   * charges the payer `amount_cents + tax`, so the response's
   * `amount_cents` comes back *larger* than the one you sent, because it
   * is always what was actually charged. Reconcile against `net_cents` /
   * `tax_cents` on the response.
   *
   * Omit to inherit the country default from your configured tax rate.
   */
  tax_behavior?: "inclusive" | "exclusive";
  metadata?: Record<string, string>;
}

export interface CreateWebhookEndpointParams extends IdempotencyOptions {
  url: string;
  enabled_events?: string[];
  description?: string;
}

export interface UpdateWebhookEndpointParams extends IdempotencyOptions {
  url?: string;
  enabled_events?: string[];
  description?: string;
  status?: string;
}

export interface EventsListParams extends BaseListParams {
  /** Server-side filter, e.g. `customer.created`. */
  type?: string;
  /** Expandable here: `customer`. `events.retrieve` accepts none. */
  expand?: string[];
}

export interface SetPortalBrandingParams extends IdempotencyOptions {
  business_name?: string;
  support_email?: string;
  logo_url?: string;
  theme?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
}

export interface RotateProviderCredentialParams extends IdempotencyOptions {
  /** New raw provider API key. Encrypted server-side; never logged. */
  api_key: string;
  /** Defaults to the calling key's mode. */
  mode?: "test" | "live" | (string & {});
  /** Currently only `"mollie"`. */
  provider?: "mollie" | (string & {});
}

export interface CreateCouponParams extends IdempotencyOptions {
  code: string;
  /**
   * `"percent"` reads `discount_value` as whole percent; `"fixed_cents"`
   * reads it as minor units off the charge. Those are the only two the
   * API accepts (`schemas/coupon.py`); anything else is a `422`.
   */
  discount_type: "percent" | "fixed_cents" | (string & {});
  discount_value: number;
  duration: "once" | "repeating" | "forever" | (string & {});
  duration_in_months?: number;
  max_redemptions?: number;
  redeem_by?: number;
  applies_to_price_ids?: string[];
  min_amount_cents?: number;
}

export interface UpdateCouponParams extends IdempotencyOptions {
  active?: boolean;
  max_redemptions?: number;
  redeem_by?: number;
  applies_to_price_ids?: string[];
  min_amount_cents?: number;
}

export interface ValidateCouponParams {
  code: string;
  /**
   * Scope the dry-run to one price. Optional: omit to validate the code
   * on its own (existence, active, not exhausted, not expired). Supply it
   * to also check the coupon's `applies_to_price_ids` restriction.
   */
  price_id?: string;
  /**
   * Base amount the discount is computed against, in minor units.
   * Optional: omit to skip the discount math and the `min_amount_cents`
   * check. `POST /v1/coupons/validate` treats both fields as nullable.
   */
  amount_cents?: number;
}

export interface CreateTaxRateParams extends IdempotencyOptions {
  country_code: string;
  rate_basis_points: number;
  display_name?: string;
  inclusive?: boolean;
}

export interface UpdateTaxRateParams extends IdempotencyOptions {
  rate_basis_points?: number;
  display_name?: string;
  inclusive?: boolean;
  active?: boolean;
}

/**
 * `auditLogs.list` params. All four filters match exactly and combine.
 *
 * `resource_type` narrows to a kind (`"customer"`, `"price"`);
 * `resource_id` narrows to one row, which is the "everything that ever
 * happened to this customer" question an audit log mostly exists for.
 * Pair them or use `resource_id` alone — ids are already unique.
 */
export interface AuditLogsListParams extends BaseListParams {
  action?: string;
  resource_type?: string;
  resource_id?: string;
  actor_id?: string;
}

/**
 * `creditNotes.list` params.
 *
 * `invoice_id` answers "was this sale credited, and by how much", which is
 * the question when reconciling one invoice; `customer_id` answers it for
 * everything credited back to one buyer.
 */
export interface CreditNotesListParams extends BaseListParams {
  invoice_id?: string;
  customer_id?: string;
}

/**
 * Body for `POST /v1/tenant/billing_profile`: the seller identity that
 * VAT is decided against and that an invoice prints.
 *
 * `country_code` is required on every call: there is nothing to leave
 * alone about a jurisdiction. Every other field is partial-update: omit
 * it to leave the stored value alone, or pass an explicit `null` to
 * clear it, because ceasing to be VAT registered (or moving office) is a
 * real event.
 */
export interface SetTenantBillingProfileParams extends IdempotencyOptions {
  /** ISO-3166-1 alpha-2, e.g. `"NL"`. */
  country_code: string;
  /** Your own EU VAT registration, or `null` to clear it. */
  vat_id?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  postal_code?: string | null;
  city?: string | null;
  registration_number?: string | null;
}

/**
 * Body for `POST /v1/api_keys`. The full key is returned **once**, on the
 * create response, and is never retrievable again.
 */
export interface CreateApiKeyParams extends IdempotencyOptions {
  /** Human label, so a key can be identified before it is revoked. */
  label?: string;
  /**
   * Narrow what the key may do. Omit to inherit the calling key's own
   * scopes; a key can never grant more than it holds.
   */
  scopes?: string[];
}

/** `invoices.void` params. `reason` is recorded on the audit row only. */
export interface VoidInvoiceParams extends IdempotencyOptions {
  reason?: string;
}

export interface CreateBillingPortalSessionParams extends IdempotencyOptions {
  subscription_id: string;
  return_url: string;
  /**
   * Also email the portal link to the subscription's customer, at the
   * address on their record, as a tenant-branded message. Defaults to
   * `false`: without it you distribute the returned `url` yourself.
   */
  deliver_email?: boolean;
}

// ─── Internals ─────────────────────────────────────────────────────

/**
 * Percent-encode a caller-supplied id before it becomes a path segment.
 *
 * Ids reach the SDK from the caller's own storage, and one carrying `/`,
 * `?` or `#` would otherwise rewrite the request: `#` truncates the path,
 * `?` turns the tail into a query string, and `/` walks to a different
 * route entirely. Encoding keeps the request on the route the method
 * names, so a bad id is a clean `404` rather than a call somewhere else.
 */
function p(id: string): string {
  return encodeURIComponent(id);
}

function dropUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Strips the `idempotencyKey` carrier from a mutating-call body and
 * returns `{ body, idempotencyKey }`. Pulled out so the per-resource
 * methods read as "describe the verb" instead of "shuffle keys".
 */
function splitIdempotency<P extends IdempotencyOptions>(
  params: P,
): { body: Record<string, unknown>; idempotencyKey: string | undefined } {
  const { idempotencyKey, ...rest } = params;
  return { body: dropUndefined(rest as Record<string, unknown>), idempotencyKey };
}

/**
 * Refuse a sub-minor-unit rate that arrived as a `number`.
 *
 * The type already forbids it, so this exists for the callers the type
 * system cannot reach: plain JavaScript, a value that came through `any`,
 * a body parsed from JSON. A double cannot hold 0.0002 exactly, so
 * accepting one would work for the rates that happen to round-trip and
 * silently mis-price the ones that do not — the worst of the three
 * available behaviours, and the reason the field is a string in the first
 * place.
 */
function assertDecimalRateIsString(value: unknown, field: string): void {
  if (value === undefined || value === null || typeof value === "string") return;
  throw new TypeError(
    `${field} must be a string, not a ${typeof value}. A JavaScript number cannot ` +
      "hold a rate like 0.0002 exactly, so it would be corrupted before it was ever " +
      `multiplied by a quantity. Pass it as a string: "${String(value)}".`,
  );
}

/** Same check at the price level and inside every band of a tier table. */
function assertPriceRatesAreStrings(params: CreatePriceParams): CreatePriceParams {
  assertDecimalRateIsString(params.unit_amount_decimal, "unit_amount_decimal");
  // Inside a tier is where a rate is most likely to be typed as a bare
  // literal, so the guard has to reach in there too.
  (params.tiers ?? []).forEach((tier, index) => {
    assertDecimalRateIsString(
      (tier as PriceTier | undefined)?.unit_amount_decimal,
      `tiers[${index}].unit_amount_decimal`,
    );
  });
  return params;
}

/**
 * Shared transport wrapper. Resources subclass this so each method
 * reads as a single line, "verb to path with params", instead of
 * the four-line `this.t.request({ ... })` boilerplate the previous
 * draft repeated everywhere.
 */
abstract class BaseResource {
  constructor(protected readonly t: Transport) {}

  /**
   * `query` is a plain object rather than an index-signature type: TypeScript
   * only gives an implicit index signature to type *aliases*, so a closed
   * `*ListParams` interface would otherwise need a cast at every call site.
   * The transport prunes `undefined`/`null` and joins arrays with commas.
   */
  protected get<T>(path: string, query?: object): Promise<T> {
    return this.t.request<T>({ method: "GET", path, query });
  }

  protected post<T, P extends IdempotencyOptions>(path: string, params: P): Promise<T> {
    const { body, idempotencyKey } = splitIdempotency(params);
    return this.t.request<T>({ method: "POST", path, body, idempotencyKey });
  }

  /** POST with no body, used by lifecycle verbs (cancel, resume, revoke ...). */
  protected postEmpty<T>(path: string, params: IdempotencyOptions = {}): Promise<T> {
    return this.t.request<T>({
      method: "POST",
      path,
      idempotencyKey: params.idempotencyKey,
    });
  }

  /** POST with a fixed body and no idempotency stripping (used by
   *  endpoints whose body is fully specified by the caller's args
   *  and not optional, e.g. `preview_update`). */
  protected postFixed<T>(
    path: string,
    body: Record<string, unknown>,
    params: IdempotencyOptions = {},
  ): Promise<T> {
    return this.t.request<T>({
      method: "POST",
      path,
      body,
      idempotencyKey: params.idempotencyKey,
    });
  }

  protected del<T>(path: string, params: IdempotencyOptions = {}): Promise<T> {
    return this.t.request<T>({
      method: "DELETE",
      path,
      idempotencyKey: params.idempotencyKey,
    });
  }
}

// ─── Resources ─────────────────────────────────────────────────────

export class Customers extends BaseResource {
  /** Create a tenant-scoped buyer record. */
  create<T = unknown>(params: CreateCustomerParams = {}): Promise<T> {
    return this.post<T, CreateCustomerParams>("/v1/customers", params);
  }

  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/customers/${p(id)}`);
  }

  update<T = unknown>(id: string, params: UpdateCustomerParams = {}): Promise<T> {
    return this.post<T, UpdateCustomerParams>(`/v1/customers/${p(id)}`, params);
  }

  /**
   * Delete a customer. Resolves to `{ id, object: "customer", deleted:
   * true }`, not the customer.
   *
   * The customer leaves the API: `retrieve()` 404s and they drop out of
   * `list()`. Their payments, invoices and refunds are untouched, and so
   * is their personal data — use {@link Customers.purge} for a GDPR
   * erasure. Refused while they hold a subscription that can still
   * charge them.
   */
  delete<T = unknown>(id: string, params: IdempotencyOptions = {}): Promise<T> {
    return this.del<T>(`/v1/customers/${p(id)}`, params);
  }

  /**
   * List customers, newest first.
   *
   * `provisional` filters on whether the customer ever completed a
   * payment. A checkout that captures an email commits its Customer
   * before the charge, so a checkout nobody finished leaves a row behind:
   * pass `false` for real customers only, `true` for the abandoned ones
   * (the cart-recovery worklist), or omit for both. Abandoned rows are
   * swept after the tenant's retention window.
   */
  list<T = unknown>(params: CustomerListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/customers", params);
  }

  /** Walk every page of `list()` and yield each customer. */
  iter<T = unknown>(options: { pageSize?: number } = {}): AsyncIterableIterator<T> {
    return paginate<T>((page) => this.get("/v1/customers", page), { pageSize: options.pageSize });
  }

  /**
   * Attach or replace the customer's VAT number; triggers server-side
   * VIES validation. The response carries `vat_number_validated`
   * reflecting whether VIES confirmed the number.
   */
  setVatNumber<T = unknown>(id: string, params: SetCustomerVatNumberParams): Promise<T> {
    return this.post<T, SetCustomerVatNumberParams>(`/v1/customers/${p(id)}/vat_number`, params);
  }

  /**
   * Hard-purge a customer's PII for GDPR erasure. Distinct from
   * `delete()` (soft delete): purge nulls email/name/country/VAT/
   * metadata, sets `purged_at`, and is irreversible.
   *
   * The server requires `confirmed: true` as a fat-finger guard; the
   * SDK defaults it to `true` so callers don't have to opt in twice.
   */
  purge<T = unknown>(id: string, params: PurgeCustomerParams = {}): Promise<T> {
    const { confirmed = true, idempotencyKey } = params;
    return this.postFixed<T>(`/v1/customers/${p(id)}/purge`, { confirmed }, { idempotencyKey });
  }
}

export class Products extends BaseResource {
  /** Create a catalog Product, then attach one or more Prices to it. */
  create<T = unknown>(params: CreateProductParams): Promise<T> {
    return this.post<T, CreateProductParams>("/v1/products", params);
  }

  /** Expandable: `prices` (every price on the product), `stats`. */
  retrieve<T = unknown>(id: string, options: ExpandOptions = {}): Promise<T> {
    return this.get<T>(`/v1/products/${p(id)}`, options);
  }

  /**
   * Patch mutable Product fields, or archive it with `active: false`.
   *
   * Archiving is how you stop offering something. The product keeps its
   * id and still comes back from `retrieve()` and `list()`, because what
   * was sold under it has to stay readable, so there is no `delete()`.
   * A checkout against any of its prices is refused from then on, and
   * `active: true` un-archives.
   */
  update<T = unknown>(id: string, params: UpdateProductParams): Promise<T> {
    return this.post<T, UpdateProductParams>(`/v1/products/${p(id)}`, params);
  }

  list<T = unknown>(params: ProductsListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/products", params);
  }

  iter<T = unknown>(options: { pageSize?: number } = {}): AsyncIterableIterator<T> {
    return paginate<T>((page) => this.get("/v1/products", page), { pageSize: options.pageSize });
  }
}

export class Prices extends BaseResource {
  /**
   * Create immutable billing terms for an existing Product.
   *
   * A licensed price sends `amount_cents`. A metered price sends one of
   * `amount_cents`, `unit_amount_decimal` (a rate finer than one minor
   * unit, as a string) or `billing_scheme: "tiered"` with `tiers` and
   * `tiers_mode`. Throws `TypeError` before any HTTP call if a decimal
   * rate arrives as a number — see
   * {@link CreatePriceParams.unit_amount_decimal}.
   */
  // `async` on purpose. The rate guard throws, and a synchronous throw out
  // of a method typed `Promise<T>` escapes `.catch()` entirely — the caller
  // would have to wrap the call site in try/catch as well, which nobody
  // does for a promise-returning API. Marking it async turns the throw into
  // a rejection, so one error path handles both.
  async create<T = unknown>(params: CreatePriceParams): Promise<T> {
    return this.post<T, CreatePriceParams>("/v1/prices", assertPriceRatesAreStrings(params));
  }

  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/prices/${p(id)}`);
  }

  /**
   * Archive a Price so it stops selling, or put it back on sale.
   *
   * `update(id, { active: false })` archives. The price keeps its id and
   * is still returned by `retrieve()` and by `list()`, because
   * subscriptions renew against it by id and what they are charged has to
   * stay readable. Subscriptions already on it keep renewing at it. What
   * stops is new business: a checkout session against the price is
   * refused and it is no longer offered as a plan change.
   *
   * `{ active: true }` undoes that. `active` is the only field because
   * `amount_cents`, `currency` and `interval` are fixed at creation, and
   * since none of them move here neither direction can change what a past
   * charge was made under. To charge something different, create a new
   * price.
   *
   * Sending the value a price already has returns it unchanged and emits
   * no second event, so a retry is safe. Archiving emits
   * `price.archived`; putting one back emits `price.updated`.
   */
  update<T = unknown>(id: string, params: UpdatePriceParams): Promise<T> {
    return this.post<T, UpdatePriceParams>(`/v1/prices/${p(id)}`, params);
  }

  list<T = unknown>(params: PricesListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/prices", params);
  }

  iter<T = unknown>(
    options: { pageSize?: number; product_id?: string } = {},
  ): AsyncIterableIterator<T> {
    const filter = options.product_id === undefined ? {} : { product_id: options.product_id };
    return paginate<T>((page) => this.get("/v1/prices", { ...filter, ...page }), {
      pageSize: options.pageSize,
    });
  }
}

export class CheckoutSessions extends BaseResource {
  create<T = unknown>(params: CreateCheckoutSessionParams): Promise<T> {
    return this.post<T, CreateCheckoutSessionParams>("/v1/checkout/sessions", params);
  }

  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/checkout/sessions/${p(id)}`);
  }
}

/**
 * Mandate-less one-shot payments (`/v1/checkout/one_shot`).
 *
 * A one-shot is the Stripe PaymentIntent shape mapped onto Mollie: a
 * single `sequenceType=oneoff` charge that provisions nothing: no
 * subscription, no mandate, no renewals. Drive terminal state via the
 * `one_shot_payment.succeeded` / `.failed` webhook events; refund one
 * with `client.refunds.create({ one_shot_payment_id })`.
 */
export class OneShotPayments extends BaseResource {
  /** Create a one-off charge; returns the object with a `redirect_url`. */
  create<T = unknown>(params: CreateOneShotPaymentParams): Promise<T> {
    return this.post<T, CreateOneShotPaymentParams>("/v1/checkout/one_shot", params);
  }

  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/checkout/one_shot/${p(id)}`);
  }
}

export class Subscriptions extends BaseResource {
  /** Expandable: `customer`, `price`, `refund_eligibility`. */
  retrieve<T = unknown>(id: string, options: ExpandOptions = {}): Promise<T> {
    return this.get<T>(`/v1/subscriptions/${p(id)}`, options);
  }

  /**
   * List subscriptions, newest first, optionally filtered.
   *
   * Reach for `renewal_state: "paused"` rather than `status: "paused"`
   * to find paused subscriptions; see `SubscriptionsListParams`.
   */
  list<T = unknown>(params: SubscriptionsListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/subscriptions", params);
  }

  /**
   * Walk every page of `list()`. Filters are carried onto each page
   * request, so a filtered walk narrows server-side instead of paging
   * the whole history and discarding rows client-side.
   */
  iter<T = unknown>(
    options: {
      pageSize?: number;
      customer_id?: string;
      status?: string;
      renewal_state?: string;
    } = {},
  ): AsyncIterableIterator<T> {
    // `undefined` query values are pruned by the transport, so the
    // filter can be spread as-is without a conditional per key.
    const { pageSize, ...filter } = options;
    return paginate<T>((page) => this.get("/v1/subscriptions", { ...filter, ...page }), { pageSize });
  }

  cancel<T = unknown>(id: string, params: IdempotencyOptions = {}): Promise<T> {
    return this.postEmpty<T>(`/v1/subscriptions/${p(id)}/cancel`, params);
  }

  pause<T = unknown>(id: string, params: IdempotencyOptions = {}): Promise<T> {
    return this.postEmpty<T>(`/v1/subscriptions/${p(id)}/pause`, params);
  }

  resume<T = unknown>(id: string, params: IdempotencyOptions = {}): Promise<T> {
    return this.postEmpty<T>(`/v1/subscriptions/${p(id)}/resume`, params);
  }

  /**
   * Reactivate a canceled-but-still-in-period subscription.
   *
   * Distinct from `resume()` (paused → active): `reactivate()` flips
   * `canceled` back to `active` for the remainder of the current
   * period, so the customer keeps service without a new checkout.
   * Returns `409` if the period has already elapsed.
   */
  reactivate<T = unknown>(id: string, params: IdempotencyOptions = {}): Promise<T> {
    return this.postEmpty<T>(`/v1/subscriptions/${p(id)}/reactivate`, params);
  }

  previewUpdate<T = unknown>(id: string, params: { target_price_id: string }): Promise<T> {
    return this.postFixed<T>(`/v1/subscriptions/${p(id)}/preview_update`, {
      target_price_id: params.target_price_id,
    });
  }

  update<T = unknown>(
    id: string,
    params: { target_price_id: string } & IdempotencyOptions,
  ): Promise<T> {
    return this.postFixed<T>(
      `/v1/subscriptions/${p(id)}/update`,
      { target_price_id: params.target_price_id },
      { idempotencyKey: params.idempotencyKey },
    );
  }

  reauthorizePaymentMethod<T = unknown>(
    id: string,
    params: { return_url: string } & IdempotencyOptions,
  ): Promise<T> {
    return this.postFixed<T>(
      `/v1/subscriptions/${p(id)}/reauthorize_payment_method`,
      { return_url: params.return_url },
      { idempotencyKey: params.idempotencyKey },
    );
  }

  /**
   * Report consumption against a metered subscription.
   *
   * Only valid when the subscription's price is `usage_type:
   * "metered"`; a licensed subscription is rejected with `400
   * parameter_invalid`. Records accumulate until the next period close
   * rolls them into one invoice line; the record's `invoice_id` stays
   * `null` until then. Records are immutable once written — they are the
   * audit trail behind that line — so there is no update or delete.
   *
   * Two dedupe mechanisms, covering different failures. The
   * `Idempotency-Key` the SDK sends covers a retry of this HTTP request,
   * including its own internal retries. `params.identifier` covers a
   * retry of *your* call, which arrives as a new request with a new key.
   * See {@link CreateUsageRecordParams.identifier}.
   */
  createUsageRecord<T = unknown>(id: string, params: CreateUsageRecordParams): Promise<T> {
    return this.post<T, CreateUsageRecordParams>(`/v1/subscriptions/${p(id)}/usage_records`, params);
  }

  /**
   * List usage records for one subscription.
   *
   * Pass `invoice_id: "pending"` to reconcile what has been reported
   * but not yet billed, or a concrete invoice id to see what that
   * invoice charged for.
   */
  listUsageRecords<T = unknown>(
    id: string,
    params: UsageRecordsListParams = {},
  ): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>(`/v1/subscriptions/${p(id)}/usage_records`, params);
  }

  /** Walk every page of `listUsageRecords()` for one subscription. */
  iterUsageRecords<T = unknown>(
    id: string,
    options: { pageSize?: number; invoice_id?: string } = {},
  ): AsyncIterableIterator<T> {
    return paginate<T>((page) => this.get(`/v1/subscriptions/${p(id)}/usage_records`, page), {
      pageSize: options.pageSize,
      filters: { invoice_id: options.invoice_id },
    });
  }

  /**
   * Price the pending usage, before the period close bills it.
   *
   * `listUsageRecords({ invoice_id: "pending" })` gives the quantity; this
   * gives the money. `net_cents` / `tax_cents` / `gross_cents` are
   * computed through the same rate or tier table and the same VAT
   * resolution the close itself uses, so it is a forecast of the real
   * invoice rather than an estimate.
   *
   * **Read `will_charge` before promising a customer an amount.** A period
   * whose total is under `minimum_charge_cents` (EUR 1.00) is not charged,
   * because the payment provider would refuse it. The usage is not lost:
   * it stays pending and rolls into the next period, which is then billed
   * for both.
   *
   * `open_invoice_id` names an earlier cycle that is invoiced and still
   * unsettled; while one is open, this period cannot be charged.
   */
  retrieveUsageSummary<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/subscriptions/${p(id)}/usage_summary`);
  }
}

export class Refunds extends BaseResource {
  create<T = unknown>(params: CreateRefundParams): Promise<T> {
    return this.post<T, CreateRefundParams>("/v1/refunds", params);
  }

  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/refunds/${p(id)}`);
  }

  list<T = unknown>(params: BaseListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/refunds", params);
  }

  iter<T = unknown>(options: { pageSize?: number } = {}): AsyncIterableIterator<T> {
    return paginate<T>((page) => this.get("/v1/refunds", page), { pageSize: options.pageSize });
  }
}

/**
 * Chargebacks / disputes (`/v1/disputes`).
 *
 * Read-only. Disputes are provider-originated (opened by the cardholder's
 * bank) and surfaced via the `dispute.created` / `dispute.closed` webhook
 * events. There is no create/update. A dispute's `status` is `open` or `won`
 * (chargeback reversed); Mollie exposes no "lost" signal, so an upheld
 * chargeback stays `open` (treat any non-`won` dispute as unresolved).
 */
export class Disputes extends BaseResource {
  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/disputes/${p(id)}`);
  }

  list<T = unknown>(params: DisputesListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/disputes", params);
  }

  iter<T = unknown>(
    options: { pageSize?: number; status?: string; payment_id?: string } = {},
  ): AsyncIterableIterator<T> {
    return paginate<T>((page) => this.get("/v1/disputes", page), {
      pageSize: options.pageSize,
      filters: { status: options.status, payment_id: options.payment_id },
    });
  }
}

export class WebhookEndpoints extends BaseResource {
  /**
   * Every event type this deployment can deliver, plus the wildcard.
   *
   * `enabled_events` rejects anything not on this list, so read it rather
   * than hard-coding a set: a name that is not on it fails at
   * registration and leaves you with an endpoint that never fires.
   */
  listEventTypes<T = unknown>(): Promise<T> {
    return this.get<T>("/v1/webhook_endpoints/event_types");
  }

  create<T = unknown>(params: CreateWebhookEndpointParams): Promise<T> {
    return this.post<T, CreateWebhookEndpointParams>("/v1/webhook_endpoints", params);
  }

  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/webhook_endpoints/${p(id)}`);
  }

  /**
   * Update an endpoint, or stop delivery with `status: "disabled"`.
   *
   * Disabling keeps the endpoint, its signing secret and its delivery
   * history, and `status: "enabled"` resumes. Use {@link
   * WebhookEndpoints.delete} when the endpoint should not exist at all:
   * disabling is reversible and deleting is not.
   */
  update<T = unknown>(id: string, params: UpdateWebhookEndpointParams): Promise<T> {
    return this.post<T, UpdateWebhookEndpointParams>(`/v1/webhook_endpoints/${p(id)}`, params);
  }

  /**
   * Delete an endpoint. Resolves to `{ id, object: "webhook_endpoint",
   * deleted: true }`, not the endpoint.
   *
   * A URL registered by mistake should not be a permanent fixture of the
   * account, so this removes it: `retrieve()` 404s afterwards and it is
   * gone from `list()`. Its delivery attempts go with it, because they
   * are readable only through the endpoint that owns them. The events
   * themselves are untouched and still in `client.events`, so what you
   * were sent stays on record.
   */
  delete<T = unknown>(id: string, params: IdempotencyOptions = {}): Promise<T> {
    return this.del<T>(`/v1/webhook_endpoints/${p(id)}`, params);
  }

  /** Rotate the signing secret. The new `bkwhsec_...` is returned once. */
  rotateSecret<T = unknown>(id: string, params: IdempotencyOptions = {}): Promise<T> {
    return this.postEmpty<T>(`/v1/webhook_endpoints/${p(id)}/rotate_secret`, params);
  }

  list<T = unknown>(params: BaseListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/webhook_endpoints", params);
  }

  iter<T = unknown>(options: { pageSize?: number } = {}): AsyncIterableIterator<T> {
    return paginate<T>((page) => this.get("/v1/webhook_endpoints", page), {
      pageSize: options.pageSize,
    });
  }

  /**
   * List per-attempt delivery records for one endpoint.
   *
   * Useful when a tenant's receiver is failing. Surfaces the status
   * code, response body excerpt, error, and next-attempt timestamp
   * for each event × endpoint pair.
   */
  listDeliveries<T = unknown>(
    endpointId: string,
    params: BaseListParams = {},
  ): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>(
      `/v1/webhook_endpoints/${p(endpointId)}/deliveries`,
      params,
    );
  }

  /** Walk every page of `listDeliveries()` for one endpoint. */
  iterDeliveries<T = unknown>(
    endpointId: string,
    options: { pageSize?: number } = {},
  ): AsyncIterableIterator<T> {
    return paginate<T>(
      (page) => this.get(`/v1/webhook_endpoints/${p(endpointId)}/deliveries`, page),
      { pageSize: options.pageSize },
    );
  }

  /** Fetch one delivery row for inspection before deciding to redeliver. */
  retrieveDelivery<T = unknown>(endpointId: string, deliveryId: string): Promise<T> {
    return this.get<T>(`/v1/webhook_endpoints/${p(endpointId)}/deliveries/${p(deliveryId)}`);
  }

  /**
   * @deprecated Renamed to {@link WebhookEndpoints.retrieveDelivery}.
   *
   * Every other single-row fetch in every BillKit SDK is `retrieve`; this
   * one method was `get`, which meant reaching for the obvious name and
   * getting a type error. The python and php clients already spell it
   * `retrieve_delivery` / `retrieveDelivery`, so node was the outlier.
   *
   * Kept as an alias because removing it would break callers for a naming
   * preference. It will go in the next major.
   */
  getDelivery<T = unknown>(endpointId: string, deliveryId: string): Promise<T> {
    return this.retrieveDelivery<T>(endpointId, deliveryId);
  }

  /**
   * Re-enqueue a delivery row for the dispatcher.
   *
   * Idempotent: a row already in `delivered` returns unchanged. A
   * `pending` / `failed` row flips to `pending` with
   * `next_attempt_at = now()`; `attempt_count` is preserved.
   */
  redeliver<T = unknown>(
    endpointId: string,
    deliveryId: string,
    params: IdempotencyOptions = {},
  ): Promise<T> {
    return this.postEmpty<T>(
      `/v1/webhook_endpoints/${p(endpointId)}/deliveries/${p(deliveryId)}/redeliver`,
      params,
    );
  }
}

export class Events extends BaseResource {
  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/events/${p(id)}`);
  }

  list<T = unknown>(params: EventsListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/events", params);
  }

  /** Walk every page of `list()`. Pass `type` to filter at the server. */
  iter<T = unknown>(
    options: { pageSize?: number; type?: string } = {},
  ): AsyncIterableIterator<T> {
    return paginate<T>((page) => this.get("/v1/events", page), {
      pageSize: options.pageSize,
      filters: { type: options.type },
    });
  }
}

/**
 * Read + mutate tenant-level configuration.
 *
 * Exposes the Mollie capability cache, the portal-branding row, and
 * the encrypted Mollie API key. None of these are per-resource;
 * they're tenant-wide knobs.
 */
export class Tenant extends BaseResource {
  /** Cached Mollie profile shape (enabled methods, country, currency). */
  capabilities<T = unknown>(): Promise<T> {
    return this.get<T>("/v1/tenant/capabilities");
  }

  /**
   * Your registered country and VAT number: what your customers' VAT is
   * decided against.
   *
   * `country_code` is what you have stored and can be `null`;
   * `effective_country_code` is what the next charge will really use.
   * The two differ only when you have stored nothing, which is exactly
   * the case worth spotting before a first live payment.
   */
  billingProfile<T = unknown>(): Promise<T> {
    return this.get<T>("/v1/tenant/billing_profile");
  }

  /**
   * Set the seller identity. `country_code` is required on every call;
   * every other field is partial-update, with an explicit `null` to
   * clear. Changes take effect on the next charge only. Tax is written
   * onto a payment and its invoice before money moves, and nothing goes
   * back and recalculates it.
   */
  setBillingProfile<T = unknown>(params: SetTenantBillingProfileParams): Promise<T> {
    return this.post<T, SetTenantBillingProfileParams>("/v1/tenant/billing_profile", params);
  }

  /**
   * Download everything in the account as one JSON document, as raw bytes.
   *
   * ```ts
   * await writeFile("export.json", Buffer.from(await client.tenant.export()));
   * ```
   *
   * The GDPR Article 20 portability route, and the way to take a backup.
   * It is `application/json` streamed inline, with no redirect, and each
   * record has the same shape its `GET` route returns, with
   * `billkit_export_version` naming the shape. It can be large, so write
   * it to a file rather than holding it in memory. Test and live data
   * export separately: you get whichever mode the key belongs to. The
   * access is recorded in your audit log.
   */
  export(): Promise<ArrayBuffer> {
    return this.t.requestBinary({ method: "GET", path: "/v1/tenant/export" });
  }

  /** Current portal branding row (business name, theme, capability flags). */
  portalBranding<T = unknown>(): Promise<T> {
    return this.get<T>("/v1/tenant/portal_branding");
  }

  /**
   * Partial-update the portal branding row.
   *
   * Only fields you set are sent. Pass `undefined` to leave a field
   * untouched; sending an empty string explicitly clears it.
   */
  setPortalBranding<T = unknown>(params: SetPortalBrandingParams = {}): Promise<T> {
    return this.post<T, SetPortalBrandingParams>("/v1/tenant/portal_branding", params);
  }

  /**
   * Rotate the encrypted provider credential for this tenant.
   *
   * The new `api_key` is encrypted server-side; nothing is logged.
   * `mode` defaults to the calling key's mode; prefix-mismatch
   * (`test_...` under live, `live_...` under test) is rejected at the
   * API boundary.
   */
  rotateProviderCredential<T = unknown>(params: RotateProviderCredentialParams): Promise<T> {
    return this.post<T, RotateProviderCredentialParams>(
      "/v1/tenant/provider_credential",
      params,
    );
  }
}

export class Coupons extends BaseResource {
  create<T = unknown>(params: CreateCouponParams): Promise<T> {
    return this.post<T, CreateCouponParams>("/v1/coupons", params);
  }

  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/coupons/${p(id)}`);
  }

  /**
   * Update a coupon's limits, or withdraw it with `active: false`.
   *
   * A withdrawn code is refused at checkout while the coupon stays
   * readable and discounts already applied keep working out, so there is
   * no `delete()`: a coupon that has been redeemed is part of what a
   * customer was charged. `active: true` brings the campaign back.
   */
  update<T = unknown>(id: string, params: UpdateCouponParams): Promise<T> {
    return this.post<T, UpdateCouponParams>(`/v1/coupons/${p(id)}`, params);
  }

  /**
   * Server-side dry-run of a coupon redemption.
   *
   * Returns the discount math without atomically claiming the coupon,
   * which is useful for "preview before checkout" UX.
   */
  validate<T = unknown>(params: ValidateCouponParams): Promise<T> {
    // Omit the optional fields rather than sending explicit nulls, so the
    // request body matches what a caller who only has a code would hand
    // written by hand, and so `extra="forbid"` schemas stay happy.
    const body: Record<string, unknown> = { code: params.code };
    if (params.price_id !== undefined) body["price_id"] = params.price_id;
    if (params.amount_cents !== undefined) body["amount_cents"] = params.amount_cents;
    return this.postFixed<T>("/v1/coupons/validate", body);
  }

  list<T = unknown>(params: BaseListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/coupons", params);
  }

  iter<T = unknown>(options: { pageSize?: number } = {}): AsyncIterableIterator<T> {
    return paginate<T>((page) => this.get("/v1/coupons", page), { pageSize: options.pageSize });
  }
}

export class TaxRates extends BaseResource {
  create<T = unknown>(params: CreateTaxRateParams): Promise<T> {
    return this.post<T, CreateTaxRateParams>("/v1/tax_rates", params);
  }

  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/tax_rates/${p(id)}`);
  }

  /**
   * Correct a rate, retire it with `active: false`, or bring one back.
   *
   * Retiring is how you stop charging VAT in a country. The rate stays
   * readable, because an invoice records the percentage it charged and
   * you have to be able to point at the rate that produced it, so there
   * is no `delete()`.
   */
  update<T = unknown>(id: string, params: UpdateTaxRateParams): Promise<T> {
    return this.post<T, UpdateTaxRateParams>(`/v1/tax_rates/${p(id)}`, params);
  }

  list<T = unknown>(params: BaseListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/tax_rates", params);
  }

  iter<T = unknown>(options: { pageSize?: number } = {}): AsyncIterableIterator<T> {
    return paginate<T>((page) => this.get("/v1/tax_rates", page), { pageSize: options.pageSize });
  }
}

/**
 * Read-only access to generated invoices.
 *
 * Invoices are produced by the billing pipeline; tenants don't create
 * them directly. Fetch the rendered document with
 * {@link Invoices.retrievePdf}.
 */
export class Invoices extends BaseResource {
  /** Expandable: `customer`. */
  retrieve<T = unknown>(id: string, options: ExpandOptions = {}): Promise<T> {
    return this.get<T>(`/v1/invoices/${p(id)}`, options);
  }

  /**
   * Download the rendered invoice PDF as raw bytes.
   *
   * ```ts
   * const pdf = await client.invoices.retrievePdf("inv_123");
   * await writeFile("invoice.pdf", Buffer.from(pdf));
   * ```
   *
   * Blob-backed deployments stream the bytes inline; S3-backed ones
   * answer `302` to a presigned URL, which `fetch` follows for us under
   * the SDK's own timeout and retry policy — so both storage adapters
   * look identical from here.
   *
   * Deployments with `INVOICE_PDF_ENABLED=false` never render one and
   * answer `501 rendering_pending`, which surfaces as a `ServerError`
   * whose `code` is `"rendering_pending"`; `retrieve()` still returns the
   * structured invoice for tenants who render their own.
   */
  retrievePdf(id: string): Promise<ArrayBuffer> {
    return this.t.requestBinary({ method: "GET", path: `/v1/invoices/${p(id)}/pdf` });
  }

  /**
   * Send the customer their invoice again.
   *
   * The same tenant-branded "your invoice is ready" email, with a fresh
   * portal link, because the one in the original may have expired. It
   * goes to the address captured **on the invoice**, not the customer's
   * current one: this is a copy of a document that was issued to
   * somebody. An invoice with no address on file is a
   * `InvalidRequestError` rather than a send that did not happen.
   */
  sendEmail<T = unknown>(id: string, params: IdempotencyOptions = {}): Promise<T> {
    return this.postEmpty<T>(`/v1/invoices/${p(id)}/email`, params);
  }

  list<T = unknown>(params: InvoicesListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/invoices", params);
  }

  iter<T = unknown>(
    options: {
      pageSize?: number;
      customer_id?: string;
      subscription_id?: string;
      payment_id?: string;
      status?: string;
    } = {},
  ): AsyncIterableIterator<T> {
    const { pageSize, ...filters } = options;
    return paginate<T>((page) => this.get("/v1/invoices", page), { pageSize, filters });
  }

  /**
   * Void an invoice: state that the sale was never owed.
   *
   * The invoice keeps its number and stays readable — a gapless series
   * cannot lose a row — and stops being a receivable. Use it for an
   * invoice that should not have been issued.
   *
   * A **paid** invoice is refused with a `ConflictError` whose `code` is
   * `"invoice_not_voidable"`. That is deliberate rather than a
   * limitation: once the money has moved, "never owed" is false, and the
   * document that reverses a real sale is a credit note — refund the
   * payment and one is issued when the refund settles.
   *
   * Idempotent: re-voiding an already-void invoice returns it unchanged.
   */
  void<T = unknown>(id: string, params: VoidInvoiceParams = {}): Promise<T> {
    return this.post<T, VoidInvoiceParams>(`/v1/invoices/${p(id)}/void`, params);
  }
}

/**
 * Read-only access to credit notes — the documents that reverse an
 * issued invoice.
 *
 * There is no create: a credit note is issued for you when a refund
 * settles, never on request, so that a numbered legal record is only
 * minted once the money has actually moved. A refund that is still
 * pending, one that fails, and a refund of a one-off charge that was
 * never invoiced all produce none.
 */
export class CreditNotes extends BaseResource {
  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/credit_notes/${p(id)}`);
  }

  /**
   * Download the rendered credit note PDF as raw bytes. Same storage
   * split as {@link Invoices.retrievePdf}: bytes inline or a followed
   * `302`, and `501 rendering_pending` on a deployment with no renderer.
   */
  retrievePdf(id: string): Promise<ArrayBuffer> {
    return this.t.requestBinary({ method: "GET", path: `/v1/credit_notes/${p(id)}/pdf` });
  }

  list<T = unknown>(params: CreditNotesListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/credit_notes", params);
  }

  iter<T = unknown>(
    options: { pageSize?: number; invoice_id?: string; customer_id?: string } = {},
  ): AsyncIterableIterator<T> {
    return paginate<T>((page) => this.get("/v1/credit_notes", page), {
      pageSize: options.pageSize,
      filters: { invoice_id: options.invoice_id, customer_id: options.customer_id },
    });
  }
}

/**
 * Read-only access to the per-tenant audit log.
 *
 * Supports server-side filters: `action`, `resource_type`, `actor_id`.
 * The filters are forwarded through to `iter()` so an audit walk can
 * scope to a single actor or action without client-side filtering.
 */
export class AuditLogs extends BaseResource {
  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/audit_logs/${p(id)}`);
  }

  list<T = unknown>(params: AuditLogsListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/audit_logs", params);
  }

  iter<T = unknown>(
    options: {
      pageSize?: number;
      action?: string;
      resource_type?: string;
      resource_id?: string;
      actor_id?: string;
    } = {},
  ): AsyncIterableIterator<T> {
    return paginate<T>((page) => this.get("/v1/audit_logs", page), {
      pageSize: options.pageSize,
      filters: {
        action: options.action,
        resource_type: options.resource_type,
        resource_id: options.resource_id,
        actor_id: options.actor_id,
      },
    });
  }
}

/**
 * Read-only access to the payment ledger.
 *
 * Payments are written by the billing pipeline (checkout, renewal,
 * reauthorize). Inspect attempts and their Mollie-side metadata here;
 * refunds and disputes are separate flows.
 */
export class Payments extends BaseResource {
  /** Expandable: `customer`, `subscription`. */
  retrieve<T = unknown>(id: string, options: ExpandOptions = {}): Promise<T> {
    return this.get<T>(`/v1/payments/${p(id)}`, options);
  }

  /**
   * Fetch the provider's own record of this charge, live.
   *
   * Reads Mollie at request time rather than a stored copy, so it carries
   * what BillKit deliberately does not keep: the card BIN, the iDEAL
   * bank, the provider's own status string. Reading live means it can
   * fail: a provider outage or a charge old enough to have aged out
   * answers `200` with `available: false` and a short reason, so render
   * the rest of the page regardless.
   */
  retrieveProvider<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/payments/${p(id)}/provider`);
  }

  list<T = unknown>(params: PaymentsListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/payments", params);
  }

  iter<T = unknown>(
    options: { pageSize?: number; customer_id?: string } = {},
  ): AsyncIterableIterator<T> {
    return paginate<T>((page) => this.get("/v1/payments", page), {
      pageSize: options.pageSize,
      filters: { customer_id: options.customer_id },
    });
  }
}

/**
 * Mint and revoke customer-facing billing-portal sessions.
 *
 * Each session token is scoped to a single subscription with a
 * sliding 30-minute idle window and a 2-hour hard cap. The raw token
 * is returned **once** on mint; the response also includes the URL
 * the tenant embeds in their app.
 */
export class BillingPortalSessions extends BaseResource {
  create<T = unknown>(params: CreateBillingPortalSessionParams): Promise<T> {
    return this.post<T, CreateBillingPortalSessionParams>("/v1/billing_portal/sessions", params);
  }

  /** Kill an in-the-wild portal session. Idempotent. */
  revoke<T = unknown>(id: string, params: IdempotencyOptions = {}): Promise<T> {
    return this.postEmpty<T>(`/v1/billing_portal/sessions/${p(id)}/revoke`, params);
  }
}

/**
 * Issue, inspect and revoke API keys.
 *
 * A key is issued in the same mode as the key that created it, so a test
 * key can only mint test keys, and it can never grant scopes it does not
 * hold itself. The secret is returned **once**, on
 * {@link ApiKeys.create}; every later read carries only the prefix.
 */
export class ApiKeys extends BaseResource {
  /**
   * Issue a new key. The response's `secret` is the only time the full
   * key exists outside the caller's own storage, so record it now.
   */
  create<T = unknown>(params: CreateApiKeyParams = {}): Promise<T> {
    return this.post<T, CreateApiKeyParams>("/v1/api_keys", params);
  }

  /**
   * One key's metadata: prefix, label, scopes, `revoked_at`, and
   * `last_used_at`, which is the field to read before revoking one.
   */
  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/api_keys/${p(id)}`);
  }

  /**
   * Revoke a key so it stops working. Immediate and irreversible; issue a
   * new key instead. Revoking an already-revoked key returns it
   * unchanged, so a retry is safe, and a key may revoke itself, which is
   * what you want when the leaked key is the one you are calling with.
   */
  revoke<T = unknown>(id: string, params: IdempotencyOptions = {}): Promise<T> {
    return this.postEmpty<T>(`/v1/api_keys/${p(id)}/revoke`, params);
  }

  /** List keys, newest first. Revoked ones are included; check `revoked_at`. */
  list<T = unknown>(params: BaseListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/api_keys", params);
  }

  iter<T = unknown>(options: { pageSize?: number } = {}): AsyncIterableIterator<T> {
    return paginate<T>((page) => this.get("/v1/api_keys", page), { pageSize: options.pageSize });
  }
}
