/**
 * Top-level BillKit client.
 *
 * Wraps a single Transport and exposes every resource family as a
 * field. The Transport is configured once at construction; every
 * resource reuses it, so a runtime-injected `fetch` impl (Cloudflare
 * Workers, MSW for tests, a debug proxy) flows through automatically.
 */

import {
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
  WebhookEndpoints,
} from "./resources.js";
import { Transport, type TransportConfig } from "./transport.js";

export interface BillKitOptions extends Omit<TransportConfig, "apiKey"> {
  /** Falls back to `process.env.BILLKIT_API_KEY` when omitted. */
  apiKey?: string;
}

function resolveApiKey(supplied: string | undefined): string {
  if (supplied) return supplied;
  const env = (globalThis.process as { env?: Record<string, string> } | undefined)?.env
    ?.["BILLKIT_API_KEY"];
  if (env) return env;
  throw new Error(
    "BillKit: missing API key. Pass { apiKey } or set BILLKIT_API_KEY in the environment.",
  );
}

export class BillKit {
  readonly apiKeys: ApiKeys;
  readonly customers: Customers;
  readonly products: Products;
  readonly prices: Prices;
  readonly checkoutSessions: CheckoutSessions;
  readonly oneShotPayments: OneShotPayments;
  readonly subscriptions: Subscriptions;
  readonly refunds: Refunds;
  readonly disputes: Disputes;
  readonly webhookEndpoints: WebhookEndpoints;
  readonly events: Events;
  readonly tenant: Tenant;
  readonly coupons: Coupons;
  readonly taxRates: TaxRates;
  readonly invoices: Invoices;
  readonly creditNotes: CreditNotes;
  readonly auditLogs: AuditLogs;
  readonly payments: Payments;
  readonly billingPortalSessions: BillingPortalSessions;

  constructor(options: BillKitOptions = {}) {
    const transport = new Transport({
      ...options,
      apiKey: resolveApiKey(options.apiKey),
    });
    this.apiKeys = new ApiKeys(transport);
    this.customers = new Customers(transport);
    this.products = new Products(transport);
    this.prices = new Prices(transport);
    this.checkoutSessions = new CheckoutSessions(transport);
    this.oneShotPayments = new OneShotPayments(transport);
    this.subscriptions = new Subscriptions(transport);
    this.refunds = new Refunds(transport);
    this.disputes = new Disputes(transport);
    this.webhookEndpoints = new WebhookEndpoints(transport);
    this.events = new Events(transport);
    this.tenant = new Tenant(transport);
    this.coupons = new Coupons(transport);
    this.taxRates = new TaxRates(transport);
    this.invoices = new Invoices(transport);
    this.creditNotes = new CreditNotes(transport);
    this.auditLogs = new AuditLogs(transport);
    this.payments = new Payments(transport);
    this.billingPortalSessions = new BillingPortalSessions(transport);
  }
}
