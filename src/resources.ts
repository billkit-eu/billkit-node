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
import type { QueryValue, Transport } from "./transport.js";

// ─── Shared parameter shapes ───────────────────────────────────────

/**
 * Cursor-pagination knobs shared by every `list()` method.
 *
 * The index signature is what lets a resource-specific extension
 * (e.g. `EventsListParams` adds `type?: string`) flow through the
 * Transport's `query` shape without a cast. Excess fields are
 * tolerated; `undefined` values are pruned before serialisation.
 */
export interface BaseListParams {
  limit?: number;
  starting_after?: string;
  // Deliberately no `ending_before`: BillKit's cursor pagination binds
  // `limit` + `starting_after` only (see `api/billkit/api/pagination.py`).
  // Advertising a backwards cursor the server ignores is worse than not
  // having one — the request succeeds and silently re-serves page 1.
  readonly [key: string]: QueryValue;
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
}

/** Optional idempotency knob carried by every mutating call. */
export interface IdempotencyOptions {
  /** Coalesces retries across process restarts. The SDK generates
   *  a random `sdk-<uuid>` key for every mutating call if you don't
   *  supply one. Pass your own when you want retries from a different
   *  process to converge on the same server-side result. */
  idempotencyKey?: string;
}

// Keep a type alias for backward compatibility with the previous
// loosely-typed ListParams. New code should reach for the
// resource-specific *ListParams (e.g. `EventsListParams`).
export type ListParams = BaseListParams & {
  readonly [key: string]: QueryValue;
};

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

/**
 * Body for `POST /v1/customers/{id}/vat_number`. The VAT number is
 * sent through VIES server-side; the response carries
 * `vat_number_validated` reflecting the outcome.
 */
export interface SetCustomerVatNumberParams extends IdempotencyOptions {
  vat_number: string;
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
}

export interface UpdateProductParams extends IdempotencyOptions {
  name?: string;
  description?: string;
  marketing_features?: string[];
  metadata?: Record<string, string>;
  /** Set false to stop selling a product without deleting history. */
  active?: boolean;
}

/**
 * Body for `POST /v1/prices/{id}`. `active` is the only field a price
 * accepts, and it moves both ways: `false` withdraws the price from sale,
 * `true` puts it back. The amount, currency and interval are fixed at
 * creation, so neither direction changes what anyone was charged.
 */
export interface UpdatePriceParams extends IdempotencyOptions {
  active: boolean;
}

export interface CreatePriceParams extends IdempotencyOptions {
  /** Existing Product id returned from `client.products.create`. */
  product_id: string;
  amount_cents: number;
  currency: string;
  interval: "month" | "year" | (string & {});
  metadata?: Record<string, string>;
  trial_days?: number;
  trial_verification_cents?: number;
  payment_methods?: Array<"creditcard" | "directdebit" | (string & {})>;
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
   * period regardless of consumption. `"metered"` bills
   * `amount_cents` **per reported unit**: post consumption with
   * `subscriptions.createUsageRecord` and the renewal invoice charges
   * `amount_cents × sum(quantity)` for the period. Metered prices
   * must be `interval: "month"`, carry `amount_cents > 0`, and cannot
   * have `trial_days`.
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
   * Pin the Mollie payment method. `undefined` lets Mollie pick from
   * the customer's available methods; when set, must be in the price's
   * `payment_methods` allowlist.
   */
  method?: "creditcard" | "directdebit" | (string & {});
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
   * `currency`; one-off methods like `bancontact`/`eps` are allowed here
   * even though they can't back a subscription.
   *
   * `giropay` was removed: the scheme shut down at the end of 2024 and the
   * server now 422s it. The `(string & {})` tail keeps this open on
   * purpose: unlike the console's read-side `PaymentMethodKind`, this is a
   * *request* type the server validates, so an SDK that lags a newly-added
   * method should not be the thing that blocks the call.
   */
  method: "creditcard" | "directdebit" | "ideal" | "bancontact" | "eps" | (string & {});
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
  discount_type: "percentage" | "amount" | (string & {});
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

export interface AuditLogsListParams extends BaseListParams {
  action?: string;
  resource_type?: string;
  actor_id?: string;
}

export interface CreateBillingPortalSessionParams extends IdempotencyOptions {
  subscription_id: string;
  return_url: string;
}

// ─── Internals ─────────────────────────────────────────────────────

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
 * Shared transport wrapper. Resources subclass this so each method
 * reads as a single line, "verb to path with params", instead of
 * the four-line `this.t.request({ ... })` boilerplate the previous
 * draft repeated everywhere.
 */
abstract class BaseResource {
  constructor(protected readonly t: Transport) {}

  protected get<T>(path: string, query?: BaseListParams & Record<string, QueryValue>): Promise<T> {
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
    return this.get<T>(`/v1/customers/${id}`);
  }

  update<T = unknown>(id: string, params: UpdateCustomerParams = {}): Promise<T> {
    return this.post<T, UpdateCustomerParams>(`/v1/customers/${id}`, params);
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
    return this.del<T>(`/v1/customers/${id}`, params);
  }

  list<T = unknown>(params: BaseListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/customers", params);
  }

  /** Walk every page of `list()` and yield each customer. */
  iter<T = unknown>(options: { pageSize?: number } = {}): AsyncIterableIterator<T> {
    return paginate<T>((p) => this.get("/v1/customers", p), { pageSize: options.pageSize });
  }

  /**
   * Attach or replace the customer's VAT number; triggers server-side
   * VIES validation. The response carries `vat_number_validated`
   * reflecting whether VIES confirmed the number.
   */
  setVatNumber<T = unknown>(id: string, params: SetCustomerVatNumberParams): Promise<T> {
    return this.post<T, SetCustomerVatNumberParams>(`/v1/customers/${id}/vat_number`, params);
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
    return this.postFixed<T>(`/v1/customers/${id}/purge`, { confirmed }, { idempotencyKey });
  }
}

export class Products extends BaseResource {
  /** Create a catalog Product, then attach one or more Prices to it. */
  create<T = unknown>(params: CreateProductParams): Promise<T> {
    return this.post<T, CreateProductParams>("/v1/products", params);
  }

  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/products/${id}`);
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
    return this.post<T, UpdateProductParams>(`/v1/products/${id}`, params);
  }

  list<T = unknown>(params: BaseListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/products", params);
  }

  iter<T = unknown>(options: { pageSize?: number } = {}): AsyncIterableIterator<T> {
    return paginate<T>((p) => this.get("/v1/products", p), { pageSize: options.pageSize });
  }
}

export class Prices extends BaseResource {
  /** Create immutable billing terms for an existing Product. */
  create<T = unknown>(params: CreatePriceParams): Promise<T> {
    return this.post<T, CreatePriceParams>("/v1/prices", params);
  }

  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/prices/${id}`);
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
    return this.post<T, UpdatePriceParams>(`/v1/prices/${id}`, params);
  }

  list<T = unknown>(params: PricesListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/prices", params);
  }

  iter<T = unknown>(
    options: { pageSize?: number; product_id?: string } = {},
  ): AsyncIterableIterator<T> {
    const filter = options.product_id === undefined ? {} : { product_id: options.product_id };
    return paginate<T>((p) => this.get("/v1/prices", { ...filter, ...p }), {
      pageSize: options.pageSize,
    });
  }
}

export class CheckoutSessions extends BaseResource {
  create<T = unknown>(params: CreateCheckoutSessionParams): Promise<T> {
    return this.post<T, CreateCheckoutSessionParams>("/v1/checkout/sessions", params);
  }

  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/checkout/sessions/${id}`);
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
    return this.get<T>(`/v1/checkout/one_shot/${id}`);
  }
}

export class Subscriptions extends BaseResource {
  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/subscriptions/${id}`);
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
    return paginate<T>((p) => this.get("/v1/subscriptions", { ...filter, ...p }), { pageSize });
  }

  cancel<T = unknown>(id: string, params: IdempotencyOptions = {}): Promise<T> {
    return this.postEmpty<T>(`/v1/subscriptions/${id}/cancel`, params);
  }

  pause<T = unknown>(id: string, params: IdempotencyOptions = {}): Promise<T> {
    return this.postEmpty<T>(`/v1/subscriptions/${id}/pause`, params);
  }

  resume<T = unknown>(id: string, params: IdempotencyOptions = {}): Promise<T> {
    return this.postEmpty<T>(`/v1/subscriptions/${id}/resume`, params);
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
    return this.postEmpty<T>(`/v1/subscriptions/${id}/reactivate`, params);
  }

  previewUpdate<T = unknown>(id: string, params: { target_price_id: string }): Promise<T> {
    return this.postFixed<T>(`/v1/subscriptions/${id}/preview_update`, {
      target_price_id: params.target_price_id,
    });
  }

  update<T = unknown>(
    id: string,
    params: { target_price_id: string } & IdempotencyOptions,
  ): Promise<T> {
    return this.postFixed<T>(
      `/v1/subscriptions/${id}/update`,
      { target_price_id: params.target_price_id },
      { idempotencyKey: params.idempotencyKey },
    );
  }

  reauthorizePaymentMethod<T = unknown>(
    id: string,
    params: { return_url: string } & IdempotencyOptions,
  ): Promise<T> {
    return this.postFixed<T>(
      `/v1/subscriptions/${id}/reauthorize_payment_method`,
      { return_url: params.return_url },
      { idempotencyKey: params.idempotencyKey },
    );
  }

  /**
   * Report consumption against a metered subscription.
   *
   * Only valid when the subscription's price is `usage_type:
   * "metered"`; a licensed subscription is rejected with `400
   * parameter_invalid`. Records accumulate until the renewal invoice
   * rolls them up (`amount_cents × sum(quantity)`); the record's
   * `invoice_id` stays `null` until then.
   *
   * Supports `Idempotency-Key` replay: retrying with the same key
   * returns the same record instead of double-counting the usage,
   * which is what makes at-least-once reporting pipelines safe.
   */
  createUsageRecord<T = unknown>(id: string, params: CreateUsageRecordParams): Promise<T> {
    return this.post<T, CreateUsageRecordParams>(`/v1/subscriptions/${id}/usage_records`, params);
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
    return this.get<ListResponseEnvelope<T>>(`/v1/subscriptions/${id}/usage_records`, params);
  }

  /** Walk every page of `listUsageRecords()` for one subscription. */
  iterUsageRecords<T = unknown>(
    id: string,
    options: { pageSize?: number; invoice_id?: string } = {},
  ): AsyncIterableIterator<T> {
    return paginate<T>((p) => this.get(`/v1/subscriptions/${id}/usage_records`, p), {
      pageSize: options.pageSize,
      filters: { invoice_id: options.invoice_id },
    });
  }
}

export class Refunds extends BaseResource {
  create<T = unknown>(params: CreateRefundParams): Promise<T> {
    return this.post<T, CreateRefundParams>("/v1/refunds", params);
  }

  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/refunds/${id}`);
  }

  list<T = unknown>(params: BaseListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/refunds", params);
  }

  iter<T = unknown>(options: { pageSize?: number } = {}): AsyncIterableIterator<T> {
    return paginate<T>((p) => this.get("/v1/refunds", p), { pageSize: options.pageSize });
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
    return this.get<T>(`/v1/disputes/${id}`);
  }

  list<T = unknown>(params: BaseListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/disputes", params);
  }

  iter<T = unknown>(options: { pageSize?: number } = {}): AsyncIterableIterator<T> {
    return paginate<T>((p) => this.get("/v1/disputes", p), { pageSize: options.pageSize });
  }
}

export class WebhookEndpoints extends BaseResource {
  create<T = unknown>(params: CreateWebhookEndpointParams): Promise<T> {
    return this.post<T, CreateWebhookEndpointParams>("/v1/webhook_endpoints", params);
  }

  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/webhook_endpoints/${id}`);
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
    return this.post<T, UpdateWebhookEndpointParams>(`/v1/webhook_endpoints/${id}`, params);
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
    return this.del<T>(`/v1/webhook_endpoints/${id}`, params);
  }

  /** Rotate the signing secret. The new `bkwhsec_...` is returned once. */
  rotateSecret<T = unknown>(id: string, params: IdempotencyOptions = {}): Promise<T> {
    return this.postEmpty<T>(`/v1/webhook_endpoints/${id}/rotate_secret`, params);
  }

  list<T = unknown>(params: BaseListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/webhook_endpoints", params);
  }

  iter<T = unknown>(options: { pageSize?: number } = {}): AsyncIterableIterator<T> {
    return paginate<T>((p) => this.get("/v1/webhook_endpoints", p), {
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
      `/v1/webhook_endpoints/${endpointId}/deliveries`,
      params,
    );
  }

  /** Walk every page of `listDeliveries()` for one endpoint. */
  iterDeliveries<T = unknown>(
    endpointId: string,
    options: { pageSize?: number } = {},
  ): AsyncIterableIterator<T> {
    return paginate<T>(
      (p) => this.get(`/v1/webhook_endpoints/${endpointId}/deliveries`, p),
      { pageSize: options.pageSize },
    );
  }

  /** Fetch one delivery row for inspection before deciding to redeliver. */
  getDelivery<T = unknown>(endpointId: string, deliveryId: string): Promise<T> {
    return this.get<T>(`/v1/webhook_endpoints/${endpointId}/deliveries/${deliveryId}`);
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
      `/v1/webhook_endpoints/${endpointId}/deliveries/${deliveryId}/redeliver`,
      params,
    );
  }
}

export class Events extends BaseResource {
  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/events/${id}`);
  }

  list<T = unknown>(params: EventsListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/events", params);
  }

  /** Walk every page of `list()`. Pass `type` to filter at the server. */
  iter<T = unknown>(
    options: { pageSize?: number; type?: string } = {},
  ): AsyncIterableIterator<T> {
    return paginate<T>((p) => this.get("/v1/events", p), {
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
    return this.get<T>(`/v1/coupons/${id}`);
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
    return this.post<T, UpdateCouponParams>(`/v1/coupons/${id}`, params);
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
    return paginate<T>((p) => this.get("/v1/coupons", p), { pageSize: options.pageSize });
  }
}

export class TaxRates extends BaseResource {
  create<T = unknown>(params: CreateTaxRateParams): Promise<T> {
    return this.post<T, CreateTaxRateParams>("/v1/tax_rates", params);
  }

  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/tax_rates/${id}`);
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
    return this.post<T, UpdateTaxRateParams>(`/v1/tax_rates/${id}`, params);
  }

  list<T = unknown>(params: BaseListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/tax_rates", params);
  }

  iter<T = unknown>(options: { pageSize?: number } = {}): AsyncIterableIterator<T> {
    return paginate<T>((p) => this.get("/v1/tax_rates", p), { pageSize: options.pageSize });
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
  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/invoices/${id}`);
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
    return this.t.requestBinary({ method: "GET", path: `/v1/invoices/${id}/pdf` });
  }

  list<T = unknown>(params: BaseListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/invoices", params);
  }

  iter<T = unknown>(options: { pageSize?: number } = {}): AsyncIterableIterator<T> {
    return paginate<T>((p) => this.get("/v1/invoices", p), { pageSize: options.pageSize });
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
    return this.get<T>(`/v1/audit_logs/${id}`);
  }

  list<T = unknown>(params: AuditLogsListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/audit_logs", params);
  }

  iter<T = unknown>(
    options: { pageSize?: number; action?: string; resource_type?: string; actor_id?: string } = {},
  ): AsyncIterableIterator<T> {
    return paginate<T>((p) => this.get("/v1/audit_logs", p), {
      pageSize: options.pageSize,
      filters: {
        action: options.action,
        resource_type: options.resource_type,
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
  retrieve<T = unknown>(id: string): Promise<T> {
    return this.get<T>(`/v1/payments/${id}`);
  }

  list<T = unknown>(params: BaseListParams = {}): Promise<ListResponseEnvelope<T>> {
    return this.get<ListResponseEnvelope<T>>("/v1/payments", params);
  }

  iter<T = unknown>(options: { pageSize?: number } = {}): AsyncIterableIterator<T> {
    return paginate<T>((p) => this.get("/v1/payments", p), { pageSize: options.pageSize });
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
    return this.postFixed<T>(
      "/v1/billing_portal/sessions",
      {
        subscription_id: params.subscription_id,
        return_url: params.return_url,
      },
      { idempotencyKey: params.idempotencyKey },
    );
  }

  /** Kill an in-the-wild portal session. Idempotent. */
  revoke<T = unknown>(id: string, params: IdempotencyOptions = {}): Promise<T> {
    return this.postEmpty<T>(`/v1/billing_portal/sessions/${id}/revoke`, params);
  }
}
