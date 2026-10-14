/**
 * Official Node.js / TypeScript SDK for BillKit.
 *
 * ```ts
 * import { BillKit } from "@billkit-eu/sdk";
 *
 * const client = new BillKit({ apiKey: process.env.BILLKIT_API_KEY });
 * const customer = await client.customers.create({ email: "ada@example.com" });
 * const product = await client.products.create({ name: "Pro" });
 * const price = await client.prices.create({
 *   product_id: product.id,
 *   amount_cents: 999,
 *   currency: "EUR",
 *   interval: "month",
 * });
 * ```
 *
 * Every response is a plain object typed from the public OpenAPI spec.
 * Every method takes {@link RequestOptions} last:
 *
 * ```ts
 * await client.refunds.create({ payment_id }, { idempotencyKey: `refund-${orderId}` });
 * ```
 *
 * Auto-pagination via async iteration, with the same filters as `list()`:
 *
 * ```ts
 * for await (const sub of client.subscriptions.iter({ status: "active", limit: 100 })) {
 *   console.log(sub.id);
 * }
 * ```
 *
 * Webhook verification returns `WebhookEvent | UnknownWebhookEvent`;
 * {@link isKnownEventType} narrows to the typed {@link WebhookEvent}:
 *
 * ```ts
 * const header = req.headers["billkit-signature"]; // string | string[] | undefined
 * const event = await verifyWebhookSignature({
 *   payload: rawBody, // the raw body (string or Uint8Array), never a parsed object
 *   signatureHeader: Array.isArray(header) ? header[0] : header,
 *   secret: process.env.BILLKIT_WEBHOOK_SECRET!,
 * });
 * if (isKnownEventType(event) && event.type === "invoice.paid") console.log(event.data.number);
 * ```
 *
 * Logging is off by default and never configures anything for you. See
 * {@link BillKitLogger} for what is logged and what is withheld (keys,
 * bodies and query strings never reach it).
 */

export { BillKit, type BillKitOptions } from "./client.js";
export {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BillKitError,
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  PaymentError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  WebhookVerificationError,
  type APIErrorCode,
  type APIErrorReason,
  type APIErrorType,
} from "./errors.js";
export type * from "./generated/models.js";
export { NOOP_LOGGER, type BillKitLogger, type LogContext } from "./logging.js";
export type {
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
  OneShotPaymentMethod,
  OneShotPaymentsListParams,
  PaymentsListParams,
  PortalTenantThemeInput,
  PreviewSubscriptionUpdateParams,
  PriceTierParams,
  PricesListParams,
  ProductsListParams,
  PurgeCustomerParams,
  ReauthorizePaymentMethodParams,
  RecurringPaymentMethod,
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
export {
  ApiKeys,
  AuditLogs,
  BillingPortalSessions,
  CheckoutSessions,
  Coupons,
  CreditNotes,
  Customers,
  Disputes,
  Events,
  Invoices,
  OneShotPayments,
  Payments,
  Prices,
  Products,
  Refunds,
  Subscriptions,
  TaxRates,
  Tenant,
  TestClocks,
  WebhookEndpoints,
} from "./resources.js";
export { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./retry.js";
export type { RequestOptions } from "./transport.js";
export { VERSION } from "./version.js";
export {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  type VerifyWebhookOptions,
  verifyWebhookSignature,
} from "./webhooks.js";
export { EVENT_TYPES, EventTypes, isKnownEventType, type EventType } from "./eventTypes.js";
