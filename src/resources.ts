/**
 * Resource accessors mirroring the BillKit API surface.
 *
 * Every method returns the decoded JSON as a plain object, typed from the
 * public OpenAPI spec (`src/generated/models.ts`). The type parameter on
 * each method defaults to that type; supplying your own is an unchecked
 * assertion, there for the rare caller who wants to narrow further.
 *
 * Signatures follow one rule: path ids first, then the call's parameters,
 * then {@link RequestOptions} last. Every method has the parameters slot,
 * including the ones the API takes no parameters for yet ({@link
 * EmptyParams}), so a parameter added later is an additive change:
 *
 *     await client.customers.create({ email }, { idempotencyKey: "signup-42" });
 *     await client.subscriptions.cancel(sub.id, {}, { timeout: 5_000 });
 *
 * Every list resource also has `iter()`, which takes exactly what `list()`
 * takes and walks every page:
 *
 *     for await (const customer of client.customers.iter({ limit: 100 })) { ... }
 */

import type {
  ApiKey,
  AuditLog,
  BillingPortalSession,
  BillingPortalSessionRevocation,
  CheckoutSession,
  Coupon,
  CouponValidation,
  CreditNote,
  Customer,
  DeletedResource,
  Dispute,
  Event,
  EventTypeList,
  Invoice,
  InvoiceEmailResult,
  ListResponse,
  OneShotPayment,
  Payment,
  PlanChangePreview,
  Price,
  Product,
  ProviderPayload,
  PurgedResource,
  Reauthorization,
  Refund,
  Subscription,
  TaxRate,
  TenantBillingProfile,
  TenantCapabilities,
  TenantPortalBranding,
  TenantProviderCredential,
  TestClock,
  UsageRecord,
  UsageSummary,
  WebhookDelivery,
  WebhookEndpoint,
} from "./generated/models.js";
import { autoPage } from "./pagination.js";
import type {
  AdvanceTestClockParams,
  AuditLogsListParams,
  BaseListParams,
  CreateApiKeyParams,
  CreateBillingPortalSessionParams,
  CreateCheckoutSessionParams,
  CreateCouponParams,
  CreateCustomerParams,
  CreateOneShotPaymentParams,
  CreatePriceParams,
  CreateProductParams,
  CreateRefundParams,
  CreateTaxRateParams,
  CreateTestClockParams,
  CreateUsageRecordParams,
  CreateWebhookEndpointParams,
  CreditNotesListParams,
  CustomerListParams,
  DisputesListParams,
  EmptyParams,
  EventsListParams,
  InvoicesListParams,
  OneShotPaymentsListParams,
  PaymentsListParams,
  PreviewSubscriptionUpdateParams,
  PricesListParams,
  ProductsListParams,
  PurgeCustomerParams,
  ReauthorizePaymentMethodParams,
  RetrieveParams,
  RotateProviderCredentialParams,
  SetCustomerVatNumberParams,
  SetPortalBrandingParams,
  SetTenantBillingProfileParams,
  SubscriptionsListParams,
  UpdateCouponParams,
  UpdateCustomerParams,
  UpdatePriceParams,
  UpdateProductParams,
  UpdateSubscriptionParams,
  UpdateTaxRateParams,
  UpdateWebhookEndpointParams,
  UsageRecordsListParams,
  ValidateCouponParams,
  VoidInvoiceParams,
} from "./params.js";
import type { RequestOptions, Transport } from "./transport.js";

// ─── Internals ─────────────────────────────────────────────────────

/**
 * Build a request path from caller-supplied ids, as a tagged template:
 * `` p`/v1/customers/${id}` ``.
 *
 * Each id is percent-encoded before it becomes a path segment. An id
 * carrying `/`, `?` or `#` would otherwise rewrite the request onto a
 * different route; encoded, a bad id is a clean `404`. An empty or
 * whitespace-only id is refused locally, because `/v1/customers/` is a
 * list, not a lookup that 404s.
 *
 * Nothing is checked here. The path is resolved inside the async request
 * helpers, so a refused id surfaces as a rejected promise rather than a
 * synchronous throw that `.catch()` never sees.
 */
function p(strings: TemplateStringsArray, ...ids: string[]): ResourcePath {
  return { strings, ids };
}

interface ResourcePath {
  readonly strings: TemplateStringsArray;
  readonly ids: readonly string[];
}

type RequestPath = string | ResourcePath;

function resolvePath(path: RequestPath): string {
  if (typeof path === "string") return path;
  let out = path.strings[0] ?? "";
  path.ids.forEach((id, i) => {
    out += encodeId(id) + (path.strings[i + 1] ?? "");
  });
  return out;
}

function encodeId(id: unknown): string {
  if (typeof id !== "string" || id.trim() === "") {
    throw new TypeError(
      `BillKit: an id is required here, got ${JSON.stringify(id)}. ` +
        "Pass the object's id (for example `cus_...`).",
    );
  }
  // `.` and `..` survive percent-encoding unchanged, and the URL parser
  // resolves them as dot segments: `customers.retrieve("..")` would become
  // `GET /v1/`, a different route rather than a lookup that 404s.
  if (id === "." || id === "..") {
    throw new TypeError(
      `BillKit: ${JSON.stringify(id)} is not an id. Pass the object's id (for example \`cus_...\`).`,
    );
  }
  return encodeURIComponent(id);
}

function dropUndefined(obj: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const REQUEST_OPTION_KEYS = new Set(["idempotencyKey", "signal", "timeout", "maxRetries", "headers"]);

/**
 * Refuse a key that is not a request option.
 *
 * The last argument used to be a parameters object on several methods
 * (`iter({ pageSize })`, `cancel(id, { idempotencyKey })`), and a value in
 * the wrong slot is otherwise silently ignored. Failing loudly is the
 * cheaper outcome for a caller mid-upgrade. That also means a superset
 * object (your own config with the options spread into it) is refused.
 *
 * A key whose value is `undefined` is treated as absent, whatever its name,
 * so `{ ...defaults, idempotencyKey: undefined }` and an optional field
 * forwarded from your own options type both work.
 */
function checkOptions(options: RequestOptions | undefined): RequestOptions | undefined {
  if (options === undefined || options === null) return undefined;
  if (typeof options !== "object") {
    throw new TypeError(`BillKit: request options must be an object, got ${typeof options}.`);
  }
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (!REQUEST_OPTION_KEYS.has(key)) {
      const hint =
        key === "pageSize"
          ? " The page size of iter() is now `limit`, in its parameters."
          : " Request options are idempotencyKey, signal, timeout, maxRetries and headers.";
      throw new TypeError(`BillKit: "${key}" is not a request option.${hint}`);
    }
  }
  return options;
}

/**
 * Refuse a request option inside the parameters. `idempotencyKey` moved to
 * the options argument in 1.0, and every id-taking method gained a
 * parameters slot before its options, so `cancel(id, { timeout })` is the
 * shape a caller mid-upgrade writes. Left alone, the key would reach the
 * API as a body field or query parameter: a 400 `parameter_unknown` that
 * names nothing about options, or, on a GET, silently nothing at all.
 *
 * `undefined` is pruned from every request anyway, so a spread that
 * carries `idempotencyKey: undefined` sends nothing wrong and is let through.
 */
function checkNotOptions(params: object): void {
  if ((params as { idempotencyKey?: unknown }).idempotencyKey !== undefined) {
    throw new TypeError(
      "BillKit: idempotencyKey belongs in the request options (the last argument), " +
        "not in the parameters: create(params, { idempotencyKey }).",
    );
  }
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && REQUEST_OPTION_KEYS.has(key)) {
      throw new TypeError(
        `BillKit: "${key}" is a request option, not a parameter. Request options are the ` +
          `last argument, after the parameters: retrieve(id, {}, { ${key} }).`,
      );
    }
  }
}

function checkParamsObject(params: unknown): void {
  if (params === undefined || params === null) return;
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new TypeError(`BillKit: parameters must be an object, got ${typeof params}.`);
  }
}

function checkBody(params: object | undefined): Record<string, unknown> | undefined {
  if (params === undefined || params === null) return undefined;
  checkNotOptions(params);
  return dropUndefined(params);
}

function checkQuery(query: object | undefined): object | undefined {
  if (query === undefined || query === null) return undefined;
  checkNotOptions(query);
  return query;
}

/**
 * Validate the parameters of a call the API takes none for yet, and send
 * nothing. The slot exists so a parameter the API adds later arrives as an
 * optional field rather than a new argument that shifts the options along.
 *
 * Any key with a value is refused: the type already forbids one, and a key
 * that reached here anyway (plain JavaScript, an `as` cast) would otherwise
 * be dropped without a word. A request option in this slot gets a hint,
 * because `cancel(id, { timeout })` was the 0.x shape.
 */
function checkEmpty(params: unknown): undefined {
  checkParamsObject(params);
  if (params === undefined || params === null) return undefined;
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const hint = REQUEST_OPTION_KEYS.has(key)
      ? ` "${key}" is a request option, and request options are the last argument: ` +
        `pass {} as the parameters, then { ${key} }.`
      : "";
    throw new TypeError(`BillKit: this call takes no parameters, so "${key}" cannot be sent.${hint}`);
  }
  return undefined;
}

/**
 * Refuse a sub-minor-unit rate that arrived as a `number`.
 *
 * The type already forbids it, so this exists for the callers the type
 * system cannot reach: plain JavaScript, a value through `any`, a body
 * parsed from JSON. A double cannot hold 0.0002 exactly, so accepting one
 * would work for the rates that happen to round-trip and silently
 * mis-price the ones that do not.
 */
function assertDecimalRateIsString(value: unknown, field: string): void {
  if (value === undefined || value === null || typeof value === "string") return;
  throw new TypeError(
    `${field} must be a string, not a ${typeof value}. A JavaScript number cannot ` +
      "hold a rate like 0.0002 exactly, so it would be corrupted before it was ever " +
      `multiplied by a quantity. Pass it as a string: "${String(value)}".`,
  );
}

function assertPriceRatesAreStrings(params: CreatePriceParams): CreatePriceParams {
  assertDecimalRateIsString(params.unit_amount_decimal, "unit_amount_decimal");
  // Inside a tier is where a rate is most likely to be typed as a bare
  // literal, so the guard reaches in there too.
  (params.tiers ?? []).forEach((tier, index) => {
    assertDecimalRateIsString(
      (tier as { unit_amount_decimal?: unknown } | undefined)?.unit_amount_decimal,
      `tiers[${index}].unit_amount_decimal`,
    );
  });
  return params;
}

/**
 * Shared request helpers. Every helper is `async` and resolves its path
 * and checks its arguments inside the body, so anything refused becomes a
 * rejection rather than a throw out of a method typed `Promise<T>`.
 */
abstract class BaseResource {
  constructor(protected readonly t: Transport) {}

  protected async get<T>(path: RequestPath, query?: object, options?: RequestOptions): Promise<T> {
    return this.t.request<T>({
      method: "GET",
      path: resolvePath(path),
      query: checkQuery(query),
      options: checkOptions(options),
    });
  }

  /** A GET whose route takes no parameters yet; see {@link checkEmpty}. */
  protected async getNone<T>(path: RequestPath, params: unknown, options?: RequestOptions): Promise<T> {
    return this.get<T>(path, checkEmpty(params), options);
  }

  protected async getBinary(
    path: RequestPath,
    params: unknown,
    options?: RequestOptions,
  ): Promise<ArrayBuffer> {
    checkEmpty(params);
    return this.t.request<ArrayBuffer>({
      method: "GET",
      path: resolvePath(path),
      options: checkOptions(options),
      responseType: "binary",
    });
  }

  protected async getStream(
    path: RequestPath,
    params: unknown,
    options?: RequestOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    checkEmpty(params);
    return this.t.request<ReadableStream<Uint8Array>>({
      method: "GET",
      path: resolvePath(path),
      options: checkOptions(options),
      responseType: "stream",
    });
  }

  protected async post<T>(path: RequestPath, params?: object, options?: RequestOptions): Promise<T> {
    checkParamsObject(params);
    return this.t.request<T>({
      method: "POST",
      path: resolvePath(path),
      body: checkBody(params),
      options: checkOptions(options),
    });
  }

  /**
   * A POST whose route takes no body yet (the lifecycle verbs). Sends no
   * body at all, as before the parameters slot existed.
   */
  protected async postNone<T>(path: RequestPath, params: unknown, options?: RequestOptions): Promise<T> {
    return this.post<T>(path, checkEmpty(params), options);
  }

  protected async del<T>(path: RequestPath, params: unknown, options?: RequestOptions): Promise<T> {
    checkEmpty(params);
    return this.t.request<T>({
      method: "DELETE",
      path: resolvePath(path),
      options: checkOptions(options),
    });
  }

  /**
   * `iter()` for any list route: the same parameters as `list()`, with
   * `limit` as the page size. Options apply to every page request.
   */
  protected async *iterate<T, P extends BaseListParams>(
    path: RequestPath,
    params: P,
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    if (
      params !== null &&
      typeof params === "object" &&
      (params as { pageSize?: unknown }).pageSize !== undefined
    ) {
      throw new TypeError(
        "BillKit: iter() takes the same parameters as list(), so its page size is `limit`; " +
          "`pageSize` was renamed in 1.0.",
      );
    }
    checkOptions(options);
    yield* autoPage<T, P>((page) => this.get<ListResponse<T>>(path, page, options), params);
  }
}

// ─── Resources ─────────────────────────────────────────────────────

export class Customers extends BaseResource {
  /** Create a buyer record. */
  create<T = Customer>(params: CreateCustomerParams = {}, options?: RequestOptions): Promise<T> {
    return this.post<T>("/v1/customers", params, options);
  }

  retrieve<T = Customer>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>(p`/v1/customers/${id}`, params, options);
  }

  update<T = Customer>(
    id: string,
    params: UpdateCustomerParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.post<T>(p`/v1/customers/${id}`, params, options);
  }

  /**
   * Delete a customer. Resolves to `{ id, object: "customer", deleted:
   * true }`, not the customer.
   *
   * The customer leaves the API: `retrieve()` 404s and they drop out of
   * `list()`. Their payments, invoices and refunds are untouched, and so is
   * their personal data; use {@link Customers.purge} for an erasure.
   * Refused while they hold a subscription that can still charge them.
   */
  delete<T = DeletedResource<"customer">>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.del<T>(p`/v1/customers/${id}`, params, options);
  }

  /**
   * List customers, newest first. `provisional: false` returns customers
   * who paid, `true` abandoned checkouts (a checkout that captures an email
   * commits its customer before the charge), omitted both.
   */
  list<T = Customer>(
    params: CustomerListParams = {},
    options?: RequestOptions,
  ): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>("/v1/customers", params, options);
  }

  /** Every page of `list()`, row by row. */
  iter<T = Customer>(
    params: CustomerListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, CustomerListParams>("/v1/customers", params, options);
  }

  /**
   * Attach, replace or (with `vat_number: null`) clear the customer's VAT
   * number. The response's `vat_number_validated` reports whether VIES
   * confirmed it.
   */
  setVatNumber<T = Customer>(
    id: string,
    params: SetCustomerVatNumberParams,
    options?: RequestOptions,
  ): Promise<T> {
    return this.post<T>(p`/v1/customers/${id}/vat_number`, params, options);
  }

  /**
   * Erase a customer's personal data (GDPR Article 17). Irreversible:
   * name, VAT number and metadata are cleared, the email is replaced with a
   * `redacted+<uuid>@invalid` placeholder, and the event log and the stored
   * provider payloads are redacted.
   *
   * Resolves to the same marker `delete()` does, plus `purged: true`
   * (`{ id, object: "customer", deleted: true, purged: true }`), not the
   * customer: a purged customer 404s afterwards exactly like a deleted one.
   *
   * `{ confirmed: true }` is required. Without it the call is refused here,
   * before any request is sent:
   *
   *     await client.customers.purge(customer.id, { confirmed: true });
   */
  async purge<T = PurgedResource<"customer">>(
    id: string,
    params: PurgeCustomerParams,
    options?: RequestOptions,
  ): Promise<T> {
    if ((params as { confirmed?: unknown } | undefined)?.confirmed !== true) {
      throw new TypeError(
        "BillKit: customers.purge erases personal data and cannot be undone. " +
          "Pass { confirmed: true } as the second argument to confirm it; nothing was sent.",
      );
    }
    return this.post<T>(p`/v1/customers/${id}/purge`, { confirmed: true }, options);
  }
}

export class Products extends BaseResource {
  /** Create a catalogue product, then attach prices to it. */
  create<T = Product>(params: CreateProductParams, options?: RequestOptions): Promise<T> {
    return this.post<T>("/v1/products", params, options);
  }

  /**
   * Expandable: `prices` (every price on the product), `stats`, and
   * `default_price` (the price `default_price_id` names).
   */
  retrieve<T = Product>(
    id: string,
    params: RetrieveParams<"prices" | "stats" | "default_price"> = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.get<T>(p`/v1/products/${id}`, params, options);
  }

  /**
   * Change a product, or archive it with `active: false`. An archived
   * product keeps its id and stays readable, because what was sold under it
   * has to; checkouts against its prices are refused. `active: true`
   * un-archives.
   */
  update<T = Product>(id: string, params: UpdateProductParams, options?: RequestOptions): Promise<T> {
    return this.post<T>(p`/v1/products/${id}`, params, options);
  }

  list<T = Product>(
    params: ProductsListParams = {},
    options?: RequestOptions,
  ): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>("/v1/products", params, options);
  }

  iter<T = Product>(
    params: ProductsListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, ProductsListParams>("/v1/products", params, options);
  }
}

export class Prices extends BaseResource {
  /**
   * Create billing terms for a product.
   *
   * A licensed price sends `amount_cents`. A metered price sends one of
   * `amount_cents`, `unit_amount_decimal` (as a string) or
   * `billing_scheme: "tiered"` with `tiers` and `tiers_mode`. Rejects with
   * a `TypeError` before any request if a decimal rate arrives as a number.
   */
  async create<T = Price>(params: CreatePriceParams, options?: RequestOptions): Promise<T> {
    return this.post<T>("/v1/prices", assertPriceRatesAreStrings(params), options);
  }

  retrieve<T = Price>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>(p`/v1/prices/${id}`, params, options);
  }

  /**
   * Archive a price with `active: false`, put it back with `active: true`,
   * or change what applies from now on. An archived price stays readable
   * and keeps renewing its existing subscriptions; new checkouts against it
   * are refused. Re-sending the current value is a no-op with no event.
   */
  update<T = Price>(id: string, params: UpdatePriceParams, options?: RequestOptions): Promise<T> {
    return this.post<T>(p`/v1/prices/${id}`, params, options);
  }

  list<T = Price>(params: PricesListParams = {}, options?: RequestOptions): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>("/v1/prices", params, options);
  }

  iter<T = Price>(
    params: PricesListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, PricesListParams>("/v1/prices", params, options);
  }
}

export class CheckoutSessions extends BaseResource {
  /**
   * Start a checkout. Hosted (the default) returns a `url`; `ui_mode:
   * "embedded"` returns a `client_secret` for `@billkit-eu/js` instead.
   */
  create<T = CheckoutSession>(
    params: CreateCheckoutSessionParams,
    options?: RequestOptions,
  ): Promise<T> {
    return this.post<T>("/v1/checkout/sessions", params, options);
  }

  retrieve<T = CheckoutSession>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>(p`/v1/checkout/sessions/${id}`, params, options);
  }
}

/**
 * Mandate-less one-off payments: a single charge that provisions no
 * subscription and no mandate. Drive terminal state from the
 * `one_shot_payment.succeeded` / `.failed` events; refund one with
 * `refunds.create({ one_shot_payment_id })`.
 */
export class OneShotPayments extends BaseResource {
  /**
   * Create a one-off charge. Hosted (the default) returns a `redirect_url`;
   * `ui_mode: "embedded"` returns a `client_secret` for the browser
   * element. The secret is on the create response only.
   */
  create<T = OneShotPayment>(
    params: CreateOneShotPaymentParams,
    options?: RequestOptions,
  ): Promise<T> {
    return this.post<T>("/v1/checkout/one_shot", params, options);
  }

  retrieve<T = OneShotPayment>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>(p`/v1/checkout/one_shot/${id}`, params, options);
  }

  /** One-off charges, newest first. */
  list<T = OneShotPayment>(
    params: OneShotPaymentsListParams = {},
    options?: RequestOptions,
  ): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>("/v1/checkout/one_shot", params, options);
  }

  iter<T = OneShotPayment>(
    params: OneShotPaymentsListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, OneShotPaymentsListParams>("/v1/checkout/one_shot", params, options);
  }
}

export class Subscriptions extends BaseResource {
  /** Expandable: `customer`, `price`, `refund_eligibility`. */
  retrieve<T = Subscription>(
    id: string,
    params: RetrieveParams<"customer" | "price" | "refund_eligibility"> = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.get<T>(p`/v1/subscriptions/${id}`, params, options);
  }

  /**
   * Subscriptions, newest first. Find paused ones with `renewal_state:
   * "paused"`, not `status`; see {@link SubscriptionsListParams}.
   */
  list<T = Subscription>(
    params: SubscriptionsListParams = {},
    options?: RequestOptions,
  ): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>("/v1/subscriptions", params, options);
  }

  iter<T = Subscription>(
    params: SubscriptionsListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, SubscriptionsListParams>("/v1/subscriptions", params, options);
  }

  /**
   * Cancel at the end of the current period.
   *
   * While a renewal payment is still settling, this, `pause()` and
   * `update()` reject with a `ConflictError` (`409 operation_pending`,
   * `reason: "renewal_processing"`) whose message names when to retry.
   */
  cancel<T = Subscription>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.postNone<T>(p`/v1/subscriptions/${id}/cancel`, params, options);
  }

  /** Stop renewing at period end. Sets `renewal_state: "paused"`; `status` stays. */
  pause<T = Subscription>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.postNone<T>(p`/v1/subscriptions/${id}/pause`, params, options);
  }

  resume<T = Subscription>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.postNone<T>(p`/v1/subscriptions/${id}/resume`, params, options);
  }

  /**
   * Undo a cancellation while the paid period is still running. Distinct
   * from `resume()`, which undoes a pause. A `409` once the period is over.
   */
  reactivate<T = Subscription>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.postNone<T>(p`/v1/subscriptions/${id}/reactivate`, params, options);
  }

  /** The money a plan change would move, without moving it. */
  previewUpdate<T = PlanChangePreview>(
    id: string,
    params: PreviewSubscriptionUpdateParams,
    options?: RequestOptions,
  ): Promise<T> {
    return this.post<T>(
      p`/v1/subscriptions/${id}/preview_update`,
      { target_price_id: params.target_price_id },
      options,
    );
  }

  /** Change the subscription's price. */
  update<T = Subscription>(
    id: string,
    params: UpdateSubscriptionParams,
    options?: RequestOptions,
  ): Promise<T> {
    return this.post<T>(
      p`/v1/subscriptions/${id}/update`,
      { target_price_id: params.target_price_id },
      options,
    );
  }

  /** Start replacing the payment method; returns where to send the customer. */
  reauthorizePaymentMethod<T = Reauthorization>(
    id: string,
    params: ReauthorizePaymentMethodParams,
    options?: RequestOptions,
  ): Promise<T> {
    return this.post<T>(
      p`/v1/subscriptions/${id}/reauthorize_payment_method`,
      { return_url: params.return_url },
      options,
    );
  }

  /**
   * Report consumption against a metered subscription. A licensed one is
   * refused with `400 parameter_invalid`. Records are immutable once
   * written. See {@link CreateUsageRecordParams.identifier} for the dedupe
   * an idempotency key cannot do.
   */
  createUsageRecord<T = UsageRecord>(
    id: string,
    params: CreateUsageRecordParams,
    options?: RequestOptions,
  ): Promise<T> {
    return this.post<T>(p`/v1/subscriptions/${id}/usage_records`, params, options);
  }

  /**
   * Usage records for one subscription. `invoice_id: "pending"` is what has
   * been reported and not yet billed.
   */
  listUsageRecords<T = UsageRecord>(
    id: string,
    params: UsageRecordsListParams = {},
    options?: RequestOptions,
  ): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>(p`/v1/subscriptions/${id}/usage_records`, params, options);
  }

  iterUsageRecords<T = UsageRecord>(
    id: string,
    params: UsageRecordsListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, UsageRecordsListParams>(
      p`/v1/subscriptions/${id}/usage_records`,
      params,
      options,
    );
  }

  /**
   * Price the pending usage before the period close bills it, through the
   * same rate table and VAT resolution the close uses. **Read
   * `will_charge`** before promising an amount: a period under
   * `minimum_charge_cents` is not charged and rolls into the next one.
   */
  retrieveUsageSummary<T = UsageSummary>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>(p`/v1/subscriptions/${id}/usage_summary`, params, options);
  }
}

export class Refunds extends BaseResource {
  /**
   * Refund a payment, a subscription's last charge, or a one-shot. Settles
   * asynchronously: watch `refund.succeeded` and `refund.failed`.
   */
  create<T = Refund>(params: CreateRefundParams, options?: RequestOptions): Promise<T> {
    return this.post<T>("/v1/refunds", params, options);
  }

  retrieve<T = Refund>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>(p`/v1/refunds/${id}`, params, options);
  }

  list<T = Refund>(params: BaseListParams = {}, options?: RequestOptions): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>("/v1/refunds", params, options);
  }

  iter<T = Refund>(
    params: BaseListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, BaseListParams>("/v1/refunds", params, options);
  }
}

/**
 * Chargebacks, read-only. A dispute's `status` is `open` or `won`; the
 * provider sends no "lost" signal, so treat any non-`won` dispute as
 * unresolved.
 */
export class Disputes extends BaseResource {
  retrieve<T = Dispute>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>(p`/v1/disputes/${id}`, params, options);
  }

  list<T = Dispute>(
    params: DisputesListParams = {},
    options?: RequestOptions,
  ): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>("/v1/disputes", params, options);
  }

  iter<T = Dispute>(
    params: DisputesListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, DisputesListParams>("/v1/disputes", params, options);
  }
}

/**
 * Test clocks: virtual time for test mode. Create a clock, create customers
 * with `test_clock_id: clock.id`, then `advance()` it to make trials end and
 * renewals fall due for those customers only. A live key is refused.
 */
export class TestClocks extends BaseResource {
  create<T = TestClock>(params: CreateTestClockParams, options?: RequestOptions): Promise<T> {
    return this.post<T>("/v1/test_clocks", params, options);
  }

  retrieve<T = TestClock>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>(p`/v1/test_clocks/${id}`, params, options);
  }

  /**
   * Move the clock forward and run everything that falls due on the way,
   * before resolving. The idempotency key the SDK sends makes its own
   * retries replay rather than advance twice.
   */
  advance<T = TestClock>(
    id: string,
    params: AdvanceTestClockParams,
    options?: RequestOptions,
  ): Promise<T> {
    return this.post<T>(p`/v1/test_clocks/${id}/advance`, params, options);
  }

  /** Delete a clock. Its customers are kept and return to real time. */
  delete<T = DeletedResource<"test_clock">>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.del<T>(p`/v1/test_clocks/${id}`, params, options);
  }

  list<T = TestClock>(params: BaseListParams = {}, options?: RequestOptions): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>("/v1/test_clocks", params, options);
  }

  iter<T = TestClock>(
    params: BaseListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, BaseListParams>("/v1/test_clocks", params, options);
  }
}

export class WebhookEndpoints extends BaseResource {
  /**
   * Every event type an endpoint can subscribe to, plus the wildcard.
   * `enabled_events` refuses anything not on this list.
   */
  listEventTypes<T = EventTypeList>(
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>("/v1/webhook_endpoints/event_types", params, options);
  }

  /** Register an endpoint. The response carries its signing `secret`, once. */
  create<T = WebhookEndpoint>(
    params: CreateWebhookEndpointParams,
    options?: RequestOptions,
  ): Promise<T> {
    return this.post<T>("/v1/webhook_endpoints", params, options);
  }

  retrieve<T = WebhookEndpoint>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>(p`/v1/webhook_endpoints/${id}`, params, options);
  }

  /**
   * Change an endpoint, or stop delivery with `status: "disabled"`, which
   * keeps its secret and history and is reversible. Use `delete()` when it
   * should not exist at all.
   */
  update<T = WebhookEndpoint>(
    id: string,
    params: UpdateWebhookEndpointParams,
    options?: RequestOptions,
  ): Promise<T> {
    return this.post<T>(p`/v1/webhook_endpoints/${id}`, params, options);
  }

  /**
   * Delete an endpoint and its delivery attempts. The events themselves
   * stay in `client.events`.
   */
  delete<T = DeletedResource<"webhook_endpoint">>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.del<T>(p`/v1/webhook_endpoints/${id}`, params, options);
  }

  /**
   * Rotate the signing secret. The new secret is returned once; the old one
   * keeps signing alongside it for a grace period.
   */
  rotateSecret<T = WebhookEndpoint>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.postNone<T>(p`/v1/webhook_endpoints/${id}/rotate_secret`, params, options);
  }

  list<T = WebhookEndpoint>(
    params: BaseListParams = {},
    options?: RequestOptions,
  ): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>("/v1/webhook_endpoints", params, options);
  }

  iter<T = WebhookEndpoint>(
    params: BaseListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, BaseListParams>("/v1/webhook_endpoints", params, options);
  }

  /** Per-attempt delivery records for one endpoint. */
  listDeliveries<T = WebhookDelivery>(
    endpointId: string,
    params: BaseListParams = {},
    options?: RequestOptions,
  ): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>(
      p`/v1/webhook_endpoints/${endpointId}/deliveries`,
      params,
      options,
    );
  }

  iterDeliveries<T = WebhookDelivery>(
    endpointId: string,
    params: BaseListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, BaseListParams>(
      p`/v1/webhook_endpoints/${endpointId}/deliveries`,
      params,
      options,
    );
  }

  retrieveDelivery<T = WebhookDelivery>(
    endpointId: string,
    deliveryId: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>(
      p`/v1/webhook_endpoints/${endpointId}/deliveries/${deliveryId}`,
      params,
      options,
    );
  }

  /**
   * Queue a delivery to be sent again. A delivered row comes back
   * unchanged; a pending or failed one is due now. `attempt_count` is kept.
   */
  redeliver<T = WebhookDelivery>(
    endpointId: string,
    deliveryId: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.postNone<T>(
      p`/v1/webhook_endpoints/${endpointId}/deliveries/${deliveryId}/redeliver`,
      params,
      options,
    );
  }
}

export class Events extends BaseResource {
  /**
   * One event. `previous_attributes` is always present: `null` when there
   * was nothing to report, the changed fields with their old values on an
   * update.
   */
  retrieve<T = Event>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>(p`/v1/events/${id}`, params, options);
  }

  list<T = Event>(params: EventsListParams = {}, options?: RequestOptions): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>("/v1/events", params, options);
  }

  iter<T = Event>(
    params: EventsListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, EventsListParams>("/v1/events", params, options);
  }
}

/** Account-level configuration: capabilities, branding, seller identity, export. */
export class Tenant extends BaseResource {
  /** The provider capability cache: enabled methods, currencies, country. */
  retrieveCapabilities<T = TenantCapabilities>(
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>("/v1/tenant/capabilities", params, options);
  }

  /**
   * Your registered country and VAT number. `country_code` is what you
   * stored and can be `null`; `effective_country_code` is what the next
   * charge will use.
   */
  retrieveBillingProfile<T = TenantBillingProfile>(
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>("/v1/tenant/billing_profile", params, options);
  }

  /**
   * Set the seller identity. Takes effect on the next charge only: tax is
   * written onto a payment before money moves and never recalculated.
   */
  setBillingProfile<T = TenantBillingProfile>(
    params: SetTenantBillingProfileParams,
    options?: RequestOptions,
  ): Promise<T> {
    return this.post<T>("/v1/tenant/billing_profile", params, options);
  }

  /**
   * Everything in the account as one JSON document, streamed. Write it to
   * a file rather than holding it in memory:
   *
   * ```ts
   * import { createWriteStream } from "node:fs";
   * import { Readable } from "node:stream";
   * import { pipeline } from "node:stream/promises";
   *
   * const body = await client.tenant.export();
   * await pipeline(Readable.fromWeb(body), createWriteStream("export.json"));
   * ```
   *
   * The per-attempt timeout covers the response headers only. There is no
   * timeout once they have arrived: the body is yours to read at your own
   * pace, so pass a `signal` (`AbortSignal.timeout(ms)`, say) to bound it.
   * A connection lost partway through errors the stream with an
   * `APIConnectionError`, with the runtime's own error on `cause`; an abort
   * errors it with the signal's reason. Test and live data export
   * separately, by the key's mode. The access is recorded in your audit log.
   */
  export(
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    return this.getStream("/v1/tenant/export", params, options);
  }

  /** The portal branding as configured, plus what customers see. */
  retrievePortalBranding<T = TenantPortalBranding>(
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>("/v1/tenant/portal_branding", params, options);
  }

  /** Partial update: fields left `undefined` are not sent. */
  setPortalBranding<T = TenantPortalBranding>(
    params: SetPortalBrandingParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.post<T>("/v1/tenant/portal_branding", params, options);
  }

  /**
   * Replace the encrypted provider credential. A key whose prefix does not
   * match `mode` (`test_` under live, say) is refused.
   */
  rotateProviderCredential<T = TenantProviderCredential>(
    params: RotateProviderCredentialParams,
    options?: RequestOptions,
  ): Promise<T> {
    return this.post<T>("/v1/tenant/provider_credential", params, options);
  }
}

export class Coupons extends BaseResource {
  /** Exactly one of `percent_off` and `amount_off_cents`. */
  create<T = Coupon>(params: CreateCouponParams, options?: RequestOptions): Promise<T> {
    return this.post<T>("/v1/coupons", params, options);
  }

  retrieve<T = Coupon>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>(p`/v1/coupons/${id}`, params, options);
  }

  /**
   * Change a coupon's limits, or withdraw it with `active: false`. A
   * withdrawn code is refused at checkout; discounts already applied keep
   * running.
   */
  update<T = Coupon>(id: string, params: UpdateCouponParams, options?: RequestOptions): Promise<T> {
    return this.post<T>(p`/v1/coupons/${id}`, params, options);
  }

  /** A dry run of a redemption: the discount math, nothing claimed. */
  validate<T = CouponValidation>(
    params: ValidateCouponParams,
    options?: RequestOptions,
  ): Promise<T> {
    return this.post<T>("/v1/coupons/validate", params, options);
  }

  list<T = Coupon>(params: BaseListParams = {}, options?: RequestOptions): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>("/v1/coupons", params, options);
  }

  iter<T = Coupon>(
    params: BaseListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, BaseListParams>("/v1/coupons", params, options);
  }
}

export class TaxRates extends BaseResource {
  create<T = TaxRate>(params: CreateTaxRateParams, options?: RequestOptions): Promise<T> {
    return this.post<T>("/v1/tax_rates", params, options);
  }

  retrieve<T = TaxRate>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>(p`/v1/tax_rates/${id}`, params, options);
  }

  /**
   * Correct a rate, retire it with `active: false`, or bring one back. A
   * retired rate stays readable: an invoice records the rate it charged.
   */
  update<T = TaxRate>(id: string, params: UpdateTaxRateParams, options?: RequestOptions): Promise<T> {
    return this.post<T>(p`/v1/tax_rates/${id}`, params, options);
  }

  list<T = TaxRate>(params: BaseListParams = {}, options?: RequestOptions): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>("/v1/tax_rates", params, options);
  }

  iter<T = TaxRate>(
    params: BaseListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, BaseListParams>("/v1/tax_rates", params, options);
  }
}

/** Invoices, produced by the billing pipeline. There is no create. */
export class Invoices extends BaseResource {
  /** Expandable: `customer`. */
  retrieve<T = Invoice>(
    id: string,
    params: RetrieveParams<"customer"> = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.get<T>(p`/v1/invoices/${id}`, params, options);
  }

  /**
   * The rendered PDF, as bytes.
   *
   * ```ts
   * await writeFile("invoice.pdf", Buffer.from(await client.invoices.retrievePdf(id)));
   * ```
   *
   * A deployment that renders no PDFs answers `501 rendering_pending`, a
   * `ServerError` with that `code`.
   */
  retrievePdf(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<ArrayBuffer> {
    return this.getBinary(p`/v1/invoices/${id}/pdf`, params, options);
  }

  /**
   * Email the invoice to the address captured **on the invoice**, with a
   * fresh portal link. An invoice with no address on file is refused.
   */
  sendEmail<T = InvoiceEmailResult>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.postNone<T>(p`/v1/invoices/${id}/email`, params, options);
  }

  list<T = Invoice>(
    params: InvoicesListParams = {},
    options?: RequestOptions,
  ): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>("/v1/invoices", params, options);
  }

  iter<T = Invoice>(
    params: InvoicesListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, InvoicesListParams>("/v1/invoices", params, options);
  }

  /**
   * State that the sale was never owed. The invoice keeps its number and
   * stays readable. A **paid** invoice is refused (`ConflictError`, code
   * `invoice_not_voidable`): refund it, and a credit note is issued when the
   * refund settles. Re-voiding returns it unchanged.
   */
  void<T = Invoice>(id: string, params: VoidInvoiceParams = {}, options?: RequestOptions): Promise<T> {
    return this.post<T>(p`/v1/invoices/${id}/void`, params, options);
  }
}

/**
 * Credit notes, the documents that reverse an invoice. Issued for you when
 * a refund settles, never on request.
 */
export class CreditNotes extends BaseResource {
  retrieve<T = CreditNote>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>(p`/v1/credit_notes/${id}`, params, options);
  }

  /** The rendered PDF, as bytes. Same storage split as `invoices.retrievePdf`. */
  retrievePdf(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<ArrayBuffer> {
    return this.getBinary(p`/v1/credit_notes/${id}/pdf`, params, options);
  }

  list<T = CreditNote>(
    params: CreditNotesListParams = {},
    options?: RequestOptions,
  ): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>("/v1/credit_notes", params, options);
  }

  iter<T = CreditNote>(
    params: CreditNotesListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, CreditNotesListParams>("/v1/credit_notes", params, options);
  }
}

/** The account's audit log, read-only. */
export class AuditLogs extends BaseResource {
  retrieve<T = AuditLog>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>(p`/v1/audit_logs/${id}`, params, options);
  }

  list<T = AuditLog>(
    params: AuditLogsListParams = {},
    options?: RequestOptions,
  ): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>("/v1/audit_logs", params, options);
  }

  iter<T = AuditLog>(
    params: AuditLogsListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, AuditLogsListParams>("/v1/audit_logs", params, options);
  }
}

/** Subscription payments, read-only. One-off charges are `oneShotPayments`. */
export class Payments extends BaseResource {
  /**
   * Expandable: `customer`, `subscription`, and, on retrieve only,
   * `refund_eligibility`: whether `refunds.create` for the remaining
   * balance would succeed now. When `eligible` is false, treat any `reason`
   * you do not recognise as "not refundable".
   */
  retrieve<T = Payment>(
    id: string,
    params: RetrieveParams<"customer" | "subscription" | "refund_eligibility"> = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.get<T>(p`/v1/payments/${id}`, params, options);
  }

  /**
   * The provider's own record of this charge, read live. A provider outage
   * or an aged-out charge answers `200` with `available: false`.
   */
  retrieveProvider<T = ProviderPayload>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>(p`/v1/payments/${id}/provider`, params, options);
  }

  list<T = Payment>(
    params: PaymentsListParams = {},
    options?: RequestOptions,
  ): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>("/v1/payments", params, options);
  }

  iter<T = Payment>(
    params: PaymentsListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, PaymentsListParams>("/v1/payments", params, options);
  }
}

/**
 * Customer-facing billing portal sessions, each scoped to one subscription
 * with a 30-minute idle window and a 2-hour cap. The token is returned once.
 */
export class BillingPortalSessions extends BaseResource {
  create<T = BillingPortalSession>(
    params: CreateBillingPortalSessionParams,
    options?: RequestOptions,
  ): Promise<T> {
    return this.post<T>("/v1/billing_portal/sessions", params, options);
  }

  /** End a session now. Idempotent. */
  revoke<T = BillingPortalSessionRevocation>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.postNone<T>(p`/v1/billing_portal/sessions/${id}/revoke`, params, options);
  }
}

/**
 * API keys. A key is minted in its creator's mode and never with more
 * scopes than its creator holds. The secret is returned once, by `create`.
 */
export class ApiKeys extends BaseResource {
  create<T = ApiKey>(params: CreateApiKeyParams = {}, options?: RequestOptions): Promise<T> {
    return this.post<T>("/v1/api_keys", params, options);
  }

  /** Metadata only: prefix, label, scopes, `revoked_at`, `last_used_at`. */
  retrieve<T = ApiKey>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.getNone<T>(p`/v1/api_keys/${id}`, params, options);
  }

  /** Immediate and irreversible. Revoking a revoked key returns it unchanged. */
  revoke<T = ApiKey>(
    id: string,
    params: EmptyParams = {},
    options?: RequestOptions,
  ): Promise<T> {
    return this.postNone<T>(p`/v1/api_keys/${id}/revoke`, params, options);
  }

  /** Newest first, revoked keys included. */
  list<T = ApiKey>(params: BaseListParams = {}, options?: RequestOptions): Promise<ListResponse<T>> {
    return this.get<ListResponse<T>>("/v1/api_keys", params, options);
  }

  iter<T = ApiKey>(
    params: BaseListParams = {},
    options?: RequestOptions,
  ): AsyncGenerator<T, void, undefined> {
    return this.iterate<T, BaseListParams>("/v1/api_keys", params, options);
  }
}
