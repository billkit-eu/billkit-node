/**
 * Top-level BillKit client.
 *
 * Wraps a single Transport and exposes every resource family as a
 * field. The Transport is configured once at construction; every
 * resource reuses it, so an injected `fetch` (MSW for tests, a debug
 * proxy) flows through automatically.
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
  TestClocks,
  WebhookEndpoints,
} from "./resources.js";
import { Transport, type TransportConfig } from "./transport.js";

/**
 * Client options, all optional except the key.
 *
 * `timeout` and `maxRetries` are the defaults for every call; any one call
 * can override them in its own request options (the last argument).
 */
export interface BillKitOptions extends Omit<TransportConfig, "apiKey"> {
  /**
   * `bk_live_...` or `bk_test_...`. Left out (or `undefined`), it falls back
   * to `process.env.BILLKIT_API_KEY`; an empty string is refused rather
   * than read as "use the environment".
   */
  apiKey?: string | undefined;
}

const CLIENT_OPTION_KEYS: ReadonlySet<string> = new Set([
  "apiKey",
  "baseUrl",
  "timeout",
  "maxRetries",
  "retryPolicy",
  "fetch",
  "logger",
]);

/** Hints for the names a caller is most likely to reach for by mistake. */
const CLIENT_OPTION_HINTS: Readonly<Record<string, string>> = {
  timeoutMs: "use timeout (milliseconds); timeoutMs was the 0.x name.",
  apiBase: "use baseUrl.",
  baseURL: "use baseUrl.",
  maxNetworkRetries: "use maxRetries.",
  headers: "pass headers per call, in the request options (the last argument).",
};

/**
 * Refuse a client option the SDK does not know. Ignoring it would leave a
 * 0.x `timeoutMs: 5_000` silently running on the 30 second default. A key
 * whose value is `undefined` is treated as absent.
 */
function checkClientOptions(options: unknown): BillKitOptions {
  if (options === undefined || options === null) return {};
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError(`BillKit: client options must be an object, got ${typeof options}.`);
  }
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || CLIENT_OPTION_KEYS.has(key)) continue;
    const hint =
      CLIENT_OPTION_HINTS[key] ??
      `Client options are ${[...CLIENT_OPTION_KEYS].join(", ")}.`;
    throw new TypeError(`BillKit: "${key}" is not a client option: ${hint}`);
  }
  return options as BillKitOptions;
}

/**
 * The key passed, else `BILLKIT_API_KEY`. Only an absent key (`undefined`
 * or `null`) falls back to the environment. An explicit empty or blank
 * string is a configuration error, refused here: falling back would
 * quietly run with whatever key the environment holds, which in a test
 * that blanked the key on purpose can be a live one.
 */
function resolveApiKey(supplied: unknown): string {
  if (supplied !== undefined && supplied !== null) {
    if (typeof supplied !== "string") {
      throw new TypeError(`BillKit: apiKey must be a string, got ${typeof supplied}.`);
    }
    if (supplied.trim() === "") {
      throw new Error(
        "BillKit: apiKey is empty. Pass a bk_live_ or bk_test_ key, or leave apiKey out " +
          "to read BILLKIT_API_KEY from the environment.",
      );
    }
    return supplied;
  }
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
  readonly testClocks: TestClocks;

  constructor(options: BillKitOptions = {}) {
    const checked = checkClientOptions(options);
    const transport = new Transport({
      ...checked,
      apiKey: resolveApiKey(checked.apiKey),
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
    this.testClocks = new TestClocks(transport);
  }
}
