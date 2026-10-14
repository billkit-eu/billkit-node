/**
 * Compile-time checks that the hand-written request parameters match the
 * request schemas the API publishes (`src/generated/requests.ts`).
 *
 * Type-only: nothing here exists at runtime and nothing imports it, but
 * `tsc` checks it with the rest of `src/`, so `npm run typecheck` fails the
 * moment a field is added to, renamed in or dropped from a request body
 * without the SDK following. Two checks per pair:
 *
 * - the key sets are identical (a field the SDK lacks, or one the API no
 *   longer accepts, both fail);
 * - the required keys are identical (a field the API made mandatory, or
 *   relaxed, both fail).
 *
 * Value types are deliberately not compared: the SDK keeps request enums
 * open (`| (string & {})`) so a value the server adds is not blocked by an
 * SDK that lags it, which a strict comparison would flag on every one.
 *
 * When one of these fails, change the `*Params` interface in `params.ts`,
 * not this file. A deliberate difference gets its own line below with the
 * reason, as `PurgeCustomerParams` does.
 */

import type * as Req from "./generated/requests.js";
import type * as P from "./params.js";

type RequiredKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Resolves to `true`, or names the offending keys in the error. */
type Keys<A, B> =
  Same<keyof A, keyof B> extends true
    ? true
    : { sdkOnly: Exclude<keyof A, keyof B>; specOnly: Exclude<keyof B, keyof A> };

type Required_<A, B> =
  Same<RequiredKeys<A>, RequiredKeys<B>> extends true
    ? true
    : {
        requiredInSdkOnly: Exclude<RequiredKeys<A>, RequiredKeys<B>>;
        requiredInSpecOnly: Exclude<RequiredKeys<B>, RequiredKeys<A>>;
      };

/** Both checks for a body. */
type Body<A, B> = [Keys<A, B>, Required_<A, B>];

type Assert<T extends readonly true[]> = T;

export type RequestBodyConformance = Assert<
  [
    ...Body<P.CreateCustomerParams, Req.CustomerCreate>,
    ...Body<P.UpdateCustomerParams, Req.CustomerUpdate>,
    // Optional on the wire, where an absent number reads as null and clears
    // the registration. The SDK makes the caller say `null` to mean that.
    Keys<P.SetCustomerVatNumberParams, Req.CustomerVatNumberRequest>,
    // The API defaults `confirmed` to false and refuses false; the SDK makes
    // it required so the refusal happens before a request is sent.
    Keys<P.PurgeCustomerParams, Req.CustomerPurgeRequest>,
    ...Body<P.CreateProductParams, Req.ProductCreate>,
    ...Body<P.UpdateProductParams, Req.ProductUpdate>,
    ...Body<P.CreatePriceParams, Req.PriceCreate>,
    ...Body<P.UpdatePriceParams, Req.PriceUpdate>,
    ...Body<P.PriceTierParams, Req.PriceTierInput>,
    ...Body<P.CreateCheckoutSessionParams, Req.CheckoutSessionCreate>,
    ...Body<P.CreateOneShotPaymentParams, Req.OneShotPaymentCreate>,
    ...Body<P.CreateRefundParams, Req.RefundCreateRequest>,
    ...Body<P.CreateBillingPortalSessionParams, Req.BillingPortalSessionCreate>,
    ...Body<P.UpdateSubscriptionParams, Req.PlanChangeUpdateRequest>,
    ...Body<P.PreviewSubscriptionUpdateParams, Req.PlanChangePreviewRequest>,
    ...Body<P.ReauthorizePaymentMethodParams, Req.ReauthorizationRequest>,
    ...Body<P.CreateUsageRecordParams, Req.UsageRecordCreate>,
    ...Body<P.CreateCouponParams, Req.CouponCreate>,
    ...Body<P.UpdateCouponParams, Req.CouponUpdate>,
    ...Body<P.ValidateCouponParams, Req.CouponValidateRequest>,
    ...Body<P.CreateTaxRateParams, Req.TaxRateCreate>,
    ...Body<P.UpdateTaxRateParams, Req.TaxRateUpdate>,
    ...Body<P.CreateWebhookEndpointParams, Req.WebhookEndpointCreate>,
    ...Body<P.UpdateWebhookEndpointParams, Req.WebhookEndpointUpdate>,
    ...Body<P.SetPortalBrandingParams, Req.TenantPortalBrandingUpdate>,
    ...Body<P.SetTenantBillingProfileParams, Req.TenantBillingProfileUpdate>,
    ...Body<P.RotateProviderCredentialParams, Req.TenantProviderCredentialRotateRequest>,
    ...Body<P.CreateApiKeyParams, Req.ApiKeyCreateRequest>,
    ...Body<P.VoidInvoiceParams, Req.InvoiceVoid>,
    ...Body<P.CreateTestClockParams, Req.TestClockCreate>,
    ...Body<P.AdvanceTestClockParams, Req.TestClockAdvance>,
  ]
>;

/** List filters against the query parameters each list route binds. */
export type ListQueryConformance = Assert<
  [
    Keys<P.BaseListParams, Req.ListApiKeysQuery>,
    Keys<P.AuditLogsListParams, Req.ListAuditLogsQuery>,
    Keys<P.OneShotPaymentsListParams, Req.ListOneShotsQuery>,
    Keys<P.BaseListParams, Req.ListCouponsQuery>,
    Keys<P.CreditNotesListParams, Req.ListCreditNotesQuery>,
    Keys<P.CustomerListParams, Req.ListCustomersQuery>,
    Keys<P.DisputesListParams, Req.ListDisputesQuery>,
    Keys<P.EventsListParams, Req.ListEventsQuery>,
    Keys<P.InvoicesListParams, Req.ListInvoicesQuery>,
    Keys<P.PaymentsListParams, Req.ListPaymentsQuery>,
    Keys<P.PricesListParams, Req.ListPricesQuery>,
    Keys<P.ProductsListParams, Req.ListProductsQuery>,
    Keys<P.BaseListParams, Req.ListRefundsQuery>,
    Keys<P.SubscriptionsListParams, Req.ListSubscriptionsQuery>,
    Keys<P.UsageRecordsListParams, Req.ListUsageRecordsQuery>,
    Keys<P.BaseListParams, Req.ListTaxRatesQuery>,
    Keys<P.BaseListParams, Req.ListTestClocksQuery>,
    Keys<P.BaseListParams, Req.ListWebhookEndpointsQuery>,
    Keys<P.BaseListParams, Req.ListWebhookEndpointDeliveriesQuery>,
    Keys<P.RetrieveParams, Req.GetInvoiceQuery>,
    Keys<P.RetrieveParams, Req.GetPaymentQuery>,
    Keys<P.RetrieveParams, Req.GetProductQuery>,
    Keys<P.RetrieveParams, Req.GetSubscriptionQuery>,
  ]
>;
