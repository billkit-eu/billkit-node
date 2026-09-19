/**
 * Official Node.js / TypeScript SDK for BillKit.
 *
 * Quick start:
 *
 * ```ts
 * import { BillKit } from "@billkit-eu/sdk";
 *
 * const client = new BillKit({ apiKey: "bk_test_..." });
 * const customer = await client.customers.create<{ id: string }>({
 *   email: "ada@example.com",
 * });
 * const product = await client.products.create<{ id: string }>({ name: "Pro" });
 * const price = await client.prices.create<{ id: string }>({
 *   product_id: product.id,
 *   amount_cents: 999,
 *   currency: "EUR",
 *   interval: "month",
 * });
 * ```
 *
 * Auto-pagination via async iteration:
 *
 * ```ts
 * for await (const customer of client.customers.iter()) {
 *   console.log(customer);
 * }
 * ```
 *
 * Webhook verification:
 *
 * ```ts
 * try {
 *   const event = await verifyWebhookSignature({
 *     payload: rawBody,
 *     signatureHeader: req.headers["billkit-signature"],
 *     secret: process.env.BILLKIT_WEBHOOK_SECRET!,
 *   });
 * } catch (err) {
 *   return new Response(null, { status: 400 });
 * }
 * ```
 *
 * Logging is off by default and never configures anything for you. Pass
 * a logger to opt in:
 *
 * ```ts
 * const client = new BillKit({ apiKey: "bk_test_...", logger: console });
 * ```
 *
 * See {@link BillKitLogger} for what is logged and what is withheld
 * (keys, bodies and query strings never reach it).
 */

export { BillKit, type BillKitOptions } from "./client.js";
export {
  APIConnectionError,
  APIError,
  AuthenticationError,
  BillKitError,
  ConflictError,
  InvalidRequestError,
  PermissionError,
  RateLimitError,
  ResourceMissingError,
  ServerError,
} from "./errors.js";
export { NOOP_LOGGER, type BillKitLogger, type LogContext } from "./logging.js";
export { paginate, type ListResponseEnvelope, type PaginateOptions } from "./pagination.js";
export type {
  AuditLogsListParams,
  BaseListParams,
  CreateBillingPortalSessionParams,
  CreateCheckoutSessionParams,
  CreateCouponParams,
  CreateCustomerParams,
  CreateOneShotPaymentParams,
  CreatePriceParams,
  CreateProductParams,
  CreateRefundParams,
  CreateTaxRateParams,
  CreateUsageRecordParams,
  CreateWebhookEndpointParams,
  EventsListParams,
  IdempotencyOptions,
  ListParams,
  PriceTier,
  PricesListParams,
  RotateProviderCredentialParams,
  SetPortalBrandingParams,
  SubscriptionsListParams,
  UpdateCouponParams,
  UpdateCustomerParams,
  UpdateProductParams,
  UpdateTaxRateParams,
  UpdateWebhookEndpointParams,
  UsageRecordsListParams,
  ValidateCouponParams,
} from "./resources.js";
export { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./retry.js";
export { VERSION } from "./version.js";
export {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  type VerifyWebhookOptions,
  WebhookVerificationError,
  verifyWebhookSignature,
} from "./webhooks.js";
