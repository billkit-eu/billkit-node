/**
 * Request parameter shapes, one exported interface per call that takes any.
 *
 * Hand-written rather than generated, because the documentation on them is
 * the part callers read most. `src/specConformance.ts` checks each one's key
 * set against the request schema the API publishes, at compile time, so a
 * field the API adds, renames or drops fails the build here instead of
 * reaching a caller as a 400.
 *
 * Wire fields stay snake_case: they are the API's names, not the SDK's. An
 * `undefined` field is dropped before the request is sent; an explicit
 * `null` is sent as JSON null, which is how the fields documented as
 * clearable are cleared.
 */

import type { EventType } from "./eventTypes.js";
import type { PortalTenantCapabilities } from "./generated/models.js";
import type { PortalTenantThemeInput } from "./generated/requests.js";

export type { PortalTenantThemeInput };

/** A payment method that can start a subscription. Open: the server decides. */
export type RecurringPaymentMethod =
  | "creditcard"
  | "directdebit"
  | "ideal"
  | "eps"
  | "applepay"
  | "paypal"
  | (string & {});

/**
 * A payment method a one-off charge can use. Wider than
 * {@link RecurringPaymentMethod}: `bancontact` and `banktransfer` cannot
 * mint the mandate a renewal needs, but can take a single payment. No
 * `directdebit`: SEPA Direct Debit only collects renewals over a mandate,
 * and a one-off charge has none.
 */
export type OneShotPaymentMethod =
  | "creditcard"
  | "ideal"
  | "bancontact"
  | "eps"
  | "applepay"
  | "paypal"
  | "banktransfer"
  | (string & {});

// ─── Lists ─────────────────────────────────────────────────────────

/**
 * Cursor pagination, shared by every `list()` and `iter()`.
 *
 * `limit` is the page size: one page from `list()`, every page from
 * `iter()`. `starting_after` is the cursor to start after. There is no
 * `ending_before`: the API binds `limit` and `starting_after` only, and
 * advertising a backwards cursor it ignores would silently re-serve page 1.
 *
 * Every `*ListParams` is closed: a misspelled filter is a compile error,
 * not a query parameter the server ignores.
 *
 * Every optional field here and on every other params type also accepts
 * `undefined`, so a value forwarded from your own optional field compiles
 * under `exactOptionalPropertyTypes`. An `undefined` field is never sent.
 */
export interface BaseListParams {
  limit?: number | undefined;
  starting_after?: string | undefined;
}

/** `customers.list` / `customers.iter`. */
export interface CustomerListParams extends BaseListParams {
  /**
   * `false` for customers who have paid, `true` for abandoned checkouts,
   * omitted for both.
   */
  provisional?: boolean | undefined;
  /** Expandable here: `stats`. Sent as `expand=a,b`. */
  expand?: Array<"stats" | (string & {})> | undefined;
}

/** `products.list` / `products.iter`. */
export interface ProductsListParams extends BaseListParams {
  expand?: Array<"prices" | "stats" | "default_price" | (string & {})> | undefined;
}

/**
 * `prices.list` / `prices.iter`. `product_id` narrows to one product's
 * prices, which beats listing everything and filtering client-side.
 */
export interface PricesListParams extends BaseListParams {
  product_id?: string | undefined;
}

/**
 * `payments.list` / `payments.iter`. Mandate verifications are never
 * listed, so every row is a real purchase attempt; check `status` before
 * treating one as revenue.
 */
export interface PaymentsListParams extends BaseListParams {
  customer_id?: string | undefined;
  expand?: Array<"customer" | "subscription" | (string & {})> | undefined;
}

/**
 * `oneShotPayments.list` / `oneShotPayments.iter`. `payments.list` lists
 * subscription payments only; one-off charges are listed here, newest
 * first, failed and expired ones included.
 */
export interface OneShotPaymentsListParams extends BaseListParams {
  customer_id?: string | undefined;
  /** One status. Anything outside the listed values is a `400` on `status`. */
  status?:
    | "open"
    | "pending"
    | "authorized"
    | "paid"
    | "failed"
    | "expired"
    | "canceled"
    | "refunded"
    | (string & {})
    | undefined;
}

/**
 * `invoices.list` / `invoices.iter`. `payment_id` answers "which invoice did
 * this charge produce".
 */
export interface InvoicesListParams extends BaseListParams {
  customer_id?: string | undefined;
  subscription_id?: string | undefined;
  payment_id?: string | undefined;
  /**
   * One status. There is no `draft`: an invoice is issued `open`, and a
   * value outside these four is a `400` on `status`.
   */
  status?: "open" | "paid" | "uncollectible" | "void" | (string & {}) | undefined;
  expand?: Array<"customer" | (string & {})> | undefined;
}

/**
 * `disputes.list` / `disputes.iter`. `status` takes any of `open` / `won`
 * (sent comma-joined); there is no `lost`, because the provider gives no
 * signal for one. `payment_id` matches subscription payments only.
 */
export interface DisputesListParams extends BaseListParams {
  status?: Array<"open" | "won" | (string & {})> | undefined;
  payment_id?: string | undefined;
}

/**
 * `subscriptions.list` / `subscriptions.iter`. Both filters take a list,
 * sent comma-joined (`status: ["active", "past_due"]` is
 * `?status=active,past_due`), and match any of its values; an unrecognised
 * value is rejected with `400 parameter_invalid` rather than ignored.
 *
 * They answer different questions. `status` is where the subscription
 * stands with its payments; `renewal_state` is what happens at the end of
 * the current period. A paused subscription keeps `status: "active"`,
 * because the customer has paid for the period they are in, so
 * `renewal_state: "paused"` is the only way to find paused ones.
 */
export interface SubscriptionsListParams extends BaseListParams {
  customer_id?: string | undefined;
  status?:
    | Array<"incomplete" | "trialing" | "active" | "past_due" | "canceled" | (string & {})>
    | undefined;
  renewal_state?:
    | Array<"auto_renew" | "paused" | "canceling" | "stopped" | (string & {})>
    | undefined;
  expand?: Array<"customer" | "price" | "refund_eligibility" | (string & {})> | undefined;
}

/**
 * `subscriptions.listUsageRecords` / `iterUsageRecords`. `invoice_id:
 * "pending"` selects records not yet invoiced; an `inv_...` id selects the
 * records that invoice billed.
 */
export interface UsageRecordsListParams extends BaseListParams {
  invoice_id?: "pending" | (string & {}) | undefined;
}

/** `events.list` / `events.iter`. */
export interface EventsListParams extends BaseListParams {
  /**
   * Event types to match, any of them (`["invoice.paid", "invoice.voided"]`),
   * sent comma-joined. An unknown type is a `400` on `type`.
   */
  type?: Array<EventType | (string & {})> | undefined;
  expand?: Array<"customer" | (string & {})> | undefined;
}

/**
 * `auditLogs.list` / `auditLogs.iter`. All four filters match exactly and
 * combine. `resource_id` alone answers "everything that ever happened to
 * this customer".
 */
export interface AuditLogsListParams extends BaseListParams {
  action?: string | undefined;
  resource_type?: string | undefined;
  resource_id?: string | undefined;
  actor_id?: string | undefined;
}

/** `creditNotes.list` / `creditNotes.iter`. */
export interface CreditNotesListParams extends BaseListParams {
  invoice_id?: string | undefined;
  customer_id?: string | undefined;
}

/**
 * The parameters of a call the API takes none for yet: `cancel`, `revoke`,
 * `retrieve` on most resources, and so on. Only `{}` (or nothing) fits.
 *
 * The slot exists so that when the API adds a parameter to one of these
 * calls it becomes an optional field in a type of its own, which is
 * additive, rather than a new argument that would shift the request
 * options along and break every caller. Request options always go last:
 * `cancel(id, {}, { timeout: 5_000 })`. A key passed here anyway (plain
 * JavaScript, an `as` cast) is refused with a `TypeError` before any
 * request, not silently dropped.
 */
export type EmptyParams = Record<string, never>;

/** `?expand=` on a retrieve, for the routes that accept it. */
export interface RetrieveParams<R extends string = string> {
  expand?: Array<R | (string & {})> | undefined;
}

// ─── Customers ─────────────────────────────────────────────────────

export interface CreateCustomerParams {
  email?: string | null | undefined;
  name?: string | null | undefined;
  /** ISO-3166-1 alpha-2. */
  country_code?: string | null | undefined;
  metadata?: Record<string, string> | null | undefined;
  /**
   * Test mode only: attach the customer to a test clock (`clock_...`) so
   * its subscriptions follow that clock's time. Fixed at creation, and
   * read back as `test_clock_id`.
   */
  test_clock_id?: string | null | undefined;
}

export interface UpdateCustomerParams {
  email?: string | undefined;
  /** `null` clears it; omit the field to leave it alone. */
  name?: string | null | undefined;
  country_code?: string | undefined;
  /** Replaces the stored object whole; send `{}` to empty it. */
  metadata?: Record<string, string> | undefined;
}

/**
 * `customers.setVatNumber`. The number is checked against VIES
 * server-side; the response's `vat_number_validated` reports the outcome.
 * `vat_number: null` clears the registration, and is sent as an explicit
 * null rather than dropped.
 */
export interface SetCustomerVatNumberParams {
  vat_number: string | null;
  /** VIES needs a country; send it when the customer has none yet. */
  country_code?: string | null | undefined;
}

/**
 * `customers.purge`. `confirmed: true` is required, and the SDK refuses the
 * call locally without it: a purge erases personal data irreversibly, so
 * the caller has to say so in the call itself.
 */
export interface PurgeCustomerParams {
  confirmed: true;
}

// ─── Catalogue ─────────────────────────────────────────────────────

export interface CreateProductParams {
  /** Customer-facing name, for example "Pro". */
  name: string;
  description?: string | null | undefined;
  /** Ordered bullets for pricing tables and checkout pages. */
  marketing_features?: string[] | null | undefined;
  metadata?: Record<string, string> | null | undefined;
  /**
   * Let a *buyer* type a coupon code at the embedded checkout for this
   * product. Defaults to `false`. A coupon you pass yourself as
   * `coupon_code` when creating a checkout session is unaffected. The code
   * is redeemed only once the payment settles.
   */
  allow_promotion_codes?: boolean | undefined;
}

export interface UpdateProductParams {
  name?: string | undefined;
  /** `null` clears it. */
  description?: string | null | undefined;
  /** `null` empties the list. */
  marketing_features?: string[] | null | undefined;
  /** Replaces the stored object whole; send `{}` to empty it. */
  metadata?: Record<string, string> | undefined;
  /** `false` archives the product; it stays readable. */
  active?: boolean | undefined;
  allow_promotion_codes?: boolean | undefined;
  /**
   * The price the billing portal offers on that price's interval. Must be
   * an active price of this product. `null` clears the default.
   */
  default_price_id?: string | null | undefined;
}

/**
 * One band of a tiered price, as sent. (The `PriceTier` a price comes back
 * with is the response shape: its last band has `up_to: null`.)
 *
 * `up_to` is inclusive, and the **last band must be `"inf"`**. Bands must
 * strictly increase. A band names a unit rate (`unit_amount_cents`, or
 * `unit_amount_decimal` for one finer than a minor unit), a
 * `flat_amount_cents` charged once for reaching the band, or both. Write a
 * free band as `unit_amount_cents: 0`.
 */
export interface PriceTierParams {
  up_to: number | "inf";
  /** Whole minor units per unit in this band. */
  unit_amount_cents?: number | null | undefined;
  /**
   * A rate finer than one minor unit, **as a string**; see
   * {@link CreatePriceParams.unit_amount_decimal}.
   */
  unit_amount_decimal?: string | null | undefined;
  /** Charged once when usage reaches this band. Whole minor units. */
  flat_amount_cents?: number | null | undefined;
}

export interface CreatePriceParams {
  /** The product this price sells. */
  product_id: string;
  /**
   * Whole minor units per period (licensed) or per unit (metered). A
   * metered price may use `unit_amount_decimal` or `tiers` instead: exactly
   * one of the three.
   */
  amount_cents?: number | null | undefined;
  /**
   * A per-unit rate smaller than one minor unit, in **minor units**, to 12
   * decimal places. `"0.02"` is 0.02 cents, EUR 0.0002 per unit. Metered
   * prices only.
   *
   * **It is a `string`, and that is load-bearing.** A JS `number` cannot
   * hold 0.0002 exactly, so the rate would be corrupted before it was ever
   * multiplied by a quantity. The SDK throws a `TypeError` if an untyped
   * caller passes a number anyway.
   */
  unit_amount_decimal?: string | null | undefined;
  /** `"tiered"` prices by bands and needs `tiers` and `tiers_mode`. Metered only. */
  billing_scheme?: "per_unit" | "tiered" | undefined;
  /**
   * How a tier table is read. No default, because the same table is two
   * different bills: `"graduated"` prices the units inside each band;
   * `"volume"` lets the period total pick one band for every unit.
   */
  tiers_mode?: "graduated" | "volume" | null | undefined;
  /** Required when `billing_scheme` is `"tiered"`, refused otherwise. */
  tiers?: PriceTierParams[] | null | undefined;
  /** ISO 4217. Defaults to `"EUR"`. */
  currency?: string | undefined;
  interval: "month" | "year" | (string & {});
  metadata?: Record<string, string> | null | undefined;
  trial_days?: number | null | undefined;
  trial_verification_cents?: number | null | undefined;
  payment_methods?: RecurringPaymentMethod[] | null | undefined;
  /**
   * What a cancellation refunds without being asked: `"none"` (default),
   * `"full"` (the last charge) or `"prorated"` (the unused part). Both
   * non-none modes end access immediately. Metered prices must leave it at
   * `"none"`.
   */
  refund_on_cancel?: "none" | "full" | "prorated" | undefined;
  /**
   * Refund-window overrides in days. Omitted inherits the policy default;
   * `0` disables refunds for that charge type; capped at 365.
   */
  refund_window_initial_days?: number | null | undefined;
  refund_window_renewal_days?: number | null | undefined;
  /**
   * Whether `amount_cents` is gross (`"inclusive"`) or net (`"exclusive"`).
   * Omitted is `"unspecified"`, which defers to the buyer country's tax
   * rate.
   */
  tax_behavior?: "inclusive" | "exclusive" | "unspecified" | undefined;
  /**
   * `"licensed"` (default) bills per period. `"metered"` bills per reported
   * unit: report with `subscriptions.createUsageRecord`. Metered prices
   * must be monthly, cannot have `trial_days` and cannot set
   * `refund_on_cancel`.
   */
  usage_type?: "licensed" | "metered" | undefined;
}

/**
 * `prices.update`. `amount_cents`, `currency`, `interval` and `usage_type`
 * decide what a past charge was, so they are fixed at creation; what is
 * here decides what happens next. `tax_behavior` can be set once, while
 * the price is still `"unspecified"`. Only the two refund windows accept
 * `null`, which clears the override.
 */
export interface UpdatePriceParams {
  /** `false` withdraws the price from sale; `true` puts it back. */
  active?: boolean | undefined;
  metadata?: Record<string, string> | undefined;
  tax_behavior?: "inclusive" | "exclusive" | undefined;
  payment_methods?: RecurringPaymentMethod[] | undefined;
  refund_on_cancel?: "none" | "full" | "prorated" | undefined;
  refund_window_initial_days?: number | null | undefined;
  refund_window_renewal_days?: number | null | undefined;
}

// ─── Checkout and payments ─────────────────────────────────────────

export interface CreateCheckoutSessionParams {
  /** An existing customer. Exactly one of this and `customer_email`. */
  customer_id?: string | null | undefined;
  /**
   * Creates a new customer in the same transaction as the checkout. Never
   * deduplicated by email.
   */
  customer_email?: string | null | undefined;
  /** Carried onto the customer `customer_email` creates. Refused with `customer_id`. */
  customer_name?: string | null | undefined;
  price_id: string;
  success_url: string;
  cancel_url: string;
  /**
   * The buyer's ISO-3166-1 alpha-2 country, when you already know it.
   * Stored on a customer that has none, which lets VAT apply to the very
   * first charge. Never overwrites one the customer already has.
   */
  country?: string | null | undefined;
  /**
   * Pin the payment method; must be in the price's `payment_methods`.
   * Subscription-starting methods only, so narrower than the one-shot set.
   */
  payment_method?: RecurringPaymentMethod | null | undefined;
  /** A coupon code applied at checkout, claimed atomically. */
  coupon_code?: string | null | undefined;
  /** Replaces the price's `trial_days` for this checkout. `0` disables a trial. */
  trial_days_override?: number | null | undefined;
  /**
   * `"hosted"` (default) returns a `url` to redirect to. `"embedded"`
   * returns a `client_secret` for `@billkit-eu/js` instead.
   */
  ui_mode?: "hosted" | "embedded" | undefined;
  metadata?: Record<string, string> | null | undefined;
}

/**
 * `oneShotPayments.create`: a single mandate-less charge, settled once
 * against your `success_url`. No subscription, no renewals.
 */
export interface CreateOneShotPaymentParams {
  customer_id: string;
  amount_cents: number;
  /** ISO 4217, validated against your allowlist. */
  currency: string;
  /**
   * `"hosted"` (default) needs `payment_method` and returns a `redirect_url`.
   * `"embedded"` must omit `payment_method`: the response carries a short-lived
   * `client_secret` for the browser element, where the payer picks it.
   */
  ui_mode?: "hosted" | "embedded" | undefined;
  /**
   * Required for a hosted one-shot, refused on an embedded one.
   * `banktransfer` settles in days, not seconds.
   */
  payment_method?: OneShotPaymentMethod | null | undefined;
  success_url: string;
  cancel_url?: string | null | undefined;
  /** Shown on the payment page and the payer's statement. */
  description?: string | null | undefined;
  /** Refund window in days. Omitted is 30; `0` disables refunds. */
  refund_window_days?: number | null | undefined;
  /**
   * `"inclusive"` (default) charges `amount_cents` with VAT inside it.
   * `"exclusive"` adds VAT on top, so the response's `amount_cents` is
   * larger than the one you sent: it is always what was charged.
   */
  tax_behavior?: "inclusive" | "exclusive" | null | undefined;
  metadata?: Record<string, string> | null | undefined;
}

export interface CreateRefundParams {
  payment_id?: string | null | undefined;
  subscription_id?: string | null | undefined;
  /** A one-shot payment. Exactly one target of the three. */
  one_shot_payment_id?: string | null | undefined;
  /**
   * Partial refund in minor units. Omit to refund the whole remaining
   * balance. The refund that brings the total to the full charge cancels a
   * bound subscription (or marks a one-shot `refunded`).
   */
  amount_cents?: number | null | undefined;
  reason?: string | null | undefined;
}

export interface CreateBillingPortalSessionParams {
  subscription_id: string;
  return_url: string;
  /** Also email the link to the customer. Defaults to `false`. */
  deliver_email?: boolean | undefined;
}

// ─── Subscriptions ─────────────────────────────────────────────────

export interface UpdateSubscriptionParams {
  /** The price to move to. Preview the money with `previewUpdate` first. */
  target_price_id: string;
}

export type PreviewSubscriptionUpdateParams = UpdateSubscriptionParams;

export interface ReauthorizePaymentMethodParams {
  /** Where the customer comes back to after authorising the new method. */
  return_url: string;
}

/**
 * `subscriptions.createUsageRecord`. Only valid on a metered subscription.
 */
export interface CreateUsageRecordParams {
  /** Units consumed, 1 to 1,000,000. */
  quantity: number;
  /** Epoch seconds the consumption happened. Omitted is receipt time. */
  occurred_at?: number | null | undefined;
  /**
   * Your id for the thing metered, unique within the subscription. The
   * dedupe an `Idempotency-Key` cannot do: the key covers a retry of one
   * HTTP request; this covers a retry of *your* call, which arrives as a
   * new request with a new key. If your pipeline is at-least-once, this is
   * the one that matters.
   */
  identifier?: string | null | undefined;
  metadata?: Record<string, string> | null | undefined;
}

// ─── Coupons and tax ───────────────────────────────────────────────

/**
 * `coupons.create`. Exactly one of `percent_off` and `amount_off_cents`.
 */
export interface CreateCouponParams {
  code: string;
  /**
   * Percent off, more than 0 and at most 100, with up to two decimal
   * places (`12.5`). Read back as a number, so `12.5` stays `12.5`.
   */
  percent_off?: number | null | undefined;
  /** Fixed amount off, in minor units of `currency`. */
  amount_off_cents?: number | null | undefined;
  /**
   * Optional: implied by whichever of the two amounts is set, and refused
   * if it disagrees.
   */
  discount_type?: "percent" | "fixed_amount" | null | undefined;
  /** Defaults to `"once"`. */
  duration?: "once" | "repeating" | "forever" | undefined;
  /** Required with `duration: "repeating"`. */
  duration_in_months?: number | null | undefined;
  max_redemptions?: number | null | undefined;
  /** Epoch seconds. */
  redeem_by?: number | null | undefined;
  applies_to_price_ids?: string[] | null | undefined;
  min_amount_cents?: number | null | undefined;
  /**
   * ISO 4217. The currency of `amount_off_cents` and `min_amount_cents`;
   * the coupon then applies only to prices in it. A percent coupon with no
   * minimum needs none. Fixed at creation.
   */
  currency?: string | null | undefined;
}

/** `coupons.update`. `null` lifts the restriction it names. */
export interface UpdateCouponParams {
  active?: boolean | undefined;
  max_redemptions?: number | null | undefined;
  redeem_by?: number | null | undefined;
  applies_to_price_ids?: string[] | null | undefined;
  min_amount_cents?: number | null | undefined;
}

/** `coupons.validate`: a dry run that claims nothing. */
export interface ValidateCouponParams {
  code: string;
  /** Also check the coupon's price restriction. */
  price_id?: string | null | undefined;
  /** Compute the discount against this amount and check the minimum. */
  amount_cents?: number | null | undefined;
  /** The charge currency, when no `price_id` names it. */
  currency?: string | null | undefined;
}

export interface CreateTaxRateParams {
  country_code: string;
  rate_basis_points: number;
  display_name?: string | null | undefined;
  inclusive?: boolean | undefined;
}

export interface UpdateTaxRateParams {
  rate_basis_points?: number | undefined;
  /** `null` clears it. */
  display_name?: string | null | undefined;
  inclusive?: boolean | undefined;
  /** `false` retires the rate; it stays readable. */
  active?: boolean | undefined;
}

// ─── Webhook endpoints ─────────────────────────────────────────────

export interface CreateWebhookEndpointParams {
  url: string;
  /** Event types, or `["*"]`. See `webhookEndpoints.listEventTypes`. */
  enabled_events?: string[] | undefined;
  description?: string | null | undefined;
}

export interface UpdateWebhookEndpointParams {
  url?: string | undefined;
  enabled_events?: string[] | undefined;
  /** `null` clears it. */
  description?: string | null | undefined;
  /** `"disabled"` stops delivery and keeps the endpoint; `"enabled"` resumes. */
  status?: "enabled" | "disabled" | (string & {}) | undefined;
}

// ─── Tenant ────────────────────────────────────────────────────────

export interface SetPortalBrandingParams {
  business_name?: string | null | undefined;
  support_email?: string | null | undefined;
  logo_url?: string | null | undefined;
  theme?: PortalTenantThemeInput | null | undefined;
  capabilities?: PortalTenantCapabilities | null | undefined;
}

/**
 * `tenant.setBillingProfile`: the seller identity VAT is decided against.
 * `country_code` is required on every call; the rest is partial-update,
 * with `null` to clear. `vat_id` can be set once: a different value or
 * `null` afterwards is refused (`reason: "vat_id_locked"`).
 */
export interface SetTenantBillingProfileParams {
  country_code: string;
  vat_id?: string | null | undefined;
  address_line1?: string | null | undefined;
  address_line2?: string | null | undefined;
  postal_code?: string | null | undefined;
  city?: string | null | undefined;
  registration_number?: string | null | undefined;
}

export interface RotateProviderCredentialParams {
  /** The new provider API key. Encrypted server-side, never logged. */
  api_key: string;
  /** Defaults to the calling key's mode. */
  mode?: "test" | "live" | null | undefined;
  /** Currently only `"mollie"`. */
  provider?: "mollie" | (string & {}) | undefined;
}

// ─── Keys, invoices, test clocks ───────────────────────────────────

export interface CreateApiKeyParams {
  label?: string | null | undefined;
  /** Omit to inherit the calling key's scopes; a key never grants more than it holds. */
  scopes?: string[] | null | undefined;
}

/** `invoices.void`. `reason` is recorded on the audit row only. */
export interface VoidInvoiceParams {
  reason?: string | null | undefined;
}

export interface CreateTestClockParams {
  /** Unix seconds the clock starts frozen at. */
  frozen_time: number;
  name?: string | null | undefined;
}

export interface AdvanceTestClockParams {
  /** Unix seconds to move to. Must be later than the clock's current time. */
  frozen_time: number;
}
