/**
 * Type-level tests of the public surface. Never run, only compiled:
 * `npm run typecheck` compiles this file, so every `@ts-expect-error` below
 * must still be an error and every assignment must still type-check. A
 * change that loosens a response type to `unknown` or `any`, or lets a 0.x
 * call shape back in, fails the build.
 */

import type { IncomingMessage } from "node:http";

import {
  type BillKit,
  type Customer,
  type Customers,
  type EmptyParams,
  type Event,
  type EventType,
  type Invoice,
  type ListResponse,
  type Subscription,
  type UnknownWebhookEvent,
  type WebhookEvent,
  Customers as CustomersValue,
  isKnownEventType,
  verifyWebhookSignature,
} from "../../src/index.js";

declare const client: BillKit;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<T extends true>(): T | undefined {
  return undefined;
}

export async function responses(): Promise<void> {
  // Every method resolves to its spec type by default.
  const customer = await client.customers.retrieve("cus_1");
  assertType<Equal<typeof customer, Customer>>();
  const email: string | null = customer.email;
  void email;
  // @ts-expect-error: not a Customer field.
  void customer.not_a_field;

  const page = await client.subscriptions.list({ status: ["active", "past_due"] });
  assertType<Equal<typeof page, ListResponse<Subscription>>>();
  void page;

  for await (const invoice of client.invoices.iter({ customer_id: "cus_1" })) {
    assertType<Equal<typeof invoice, Invoice>>();
    void invoice;
  }

  // A deletion marker always says `deleted: true`, and names its kind.
  const deleted = await client.customers.delete("cus_1");
  const marker: true = deleted.deleted;
  assertType<Equal<typeof deleted.object, "customer">>();
  void marker;
  const clock = await client.testClocks.delete("clock_1");
  assertType<Equal<typeof clock.object, "test_clock">>();
  void clock;
  // A purge answers the same marker plus `purged: true`, never the customer.
  const purged = await client.customers.purge("cus_1", { confirmed: true });
  const purgedFlag: true = purged.purged;
  assertType<Equal<typeof purged.object, "customer">>();
  // @ts-expect-error: a purge no longer answers the customer.
  void purged.email;
  void purgedFlag;
  const endpoint = await client.webhookEndpoints.delete("we_1");
  assertType<Equal<typeof endpoint.object, "webhook_endpoint">>();
  void endpoint;

  // The resource classes are values: `instanceof` works on the accessors.
  const isCustomers: boolean = client.customers instanceof CustomersValue;
  void isCustomers;

  const event = await client.events.retrieve("evt_1");
  assertType<Equal<typeof event, Event>>();
  const previous: Record<string, unknown> | null = event.previous_attributes;
  void previous;

  const exported = await client.tenant.export();
  assertType<Equal<typeof exported, ReadableStream<Uint8Array>>>();
  void exported;

  // The escape hatch still narrows on request, and only on request.
  const narrow = await client.customers.retrieve<{ id: string }>("cus_1");
  assertType<Equal<typeof narrow, { id: string }>>();
  void narrow;
}

export function openEnums(sub: Subscription): void {
  // Known values autocomplete, and an unknown one is still a string.
  const known: Subscription["status"] = "past_due";
  const future: Subscription["status"] = "hibernating";
  void known;
  void future;
  switch (sub.renewal_state) {
    case "paused":
      break;
    default:
      break;
  }
}

export async function webhooks(payload: string, header: string): Promise<void> {
  const event = await verifyWebhookSignature({ payload, signatureHeader: header, secret: "s" });
  // Open: a type newer than this SDK is a value of the result, not a lie.
  assertType<Equal<typeof event, WebhookEvent | UnknownWebhookEvent>>();
  if (event.type === "invoice.paid") {
    // Without the guard, the unknown arm keeps `data` untyped.
    assertType<Equal<typeof event.data, unknown>>();
  }
  if (isKnownEventType(event)) {
    assertType<Equal<typeof event, WebhookEvent>>();
    if (event.type === "invoice.paid") {
      assertType<Equal<typeof event.data, Invoice>>();
    }
    if (event.type === "subscription.updated") {
      const before: Record<string, unknown> | null = event.previous_attributes;
      void before;
    }
  } else {
    assertType<Equal<typeof event, UnknownWebhookEvent>>();
    const id: string = event.id;
    void id;
  }
  // Any event type string is still a valid unknown event.
  const future: UnknownWebhookEvent["type"] = "invoice.something_new";
  void future;
  // An `Event` from the list endpoint narrows on its `type`.
  const listed = await client.events.retrieve("evt_1");
  if (isKnownEventType(listed)) {
    assertType<Equal<typeof listed.type, EventType>>();
  }
  await verifyWebhookSignature({
    payload,
    signatureHeader: header,
    secret: "s",
    // @ts-expect-error: the clock is no longer a public option.
    nowMs: 0,
  });
}

// The example in src/index.ts's JSDoc and AGENTS.md, as written. Node types
// a header as `string | string[] | undefined`, and the verifier takes one
// header value, so the example has to pick one.
export async function nodeHttpExample(req: IncomingMessage, rawBody: Buffer): Promise<void> {
  const header = req.headers["billkit-signature"]; // string | string[] | undefined
  await verifyWebhookSignature({
    payload: rawBody,
    // @ts-expect-error: a repeated header arrives as string[], which is not one value.
    signatureHeader: header,
    secret: "s",
  });
  const event = await verifyWebhookSignature({
    payload: rawBody, // the raw body (string or Uint8Array), never a parsed object
    signatureHeader: Array.isArray(header) ? header[0] : header,
    secret: process.env.BILLKIT_WEBHOOK_SECRET!,
  });
  if (isKnownEventType(event) && event.type === "invoice.paid") console.log(event.data.number);

  // The README's previous_attributes snippet, verbatim: `data` is only a
  // Subscription once isKnownEventType has narrowed away UnknownWebhookEvent.
  if (
    isKnownEventType(event) &&
    event.type === "subscription.updated" &&
    event.previous_attributes !== null
  ) {
    console.log(`status went ${String(event.previous_attributes.status)} -> ${event.data.status}`);
  }
  // @ts-expect-error: without the narrowing, data is unknown.
  if (event.type === "subscription.updated") console.log(event.data.status);
}

export async function callShapes(): Promise<void> {
  await client.refunds.create({ payment_id: "pay_1" }, { idempotencyKey: "refund-1" });
  await client.subscriptions.cancel("sub_1", {}, { timeout: 5_000, maxRetries: 0 });
  await client.customers.retrieve("cus_1", {}, { signal: AbortSignal.timeout(1_000) });
  await client.subscriptions.cancel("sub_1");

  // @ts-expect-error: options are the third argument; the second is the parameters.
  await client.subscriptions.cancel("sub_1", { timeout: 5_000 });
  // @ts-expect-error: same for a call the API takes no parameters for yet.
  await client.customers.retrieve("cus_1", { signal: AbortSignal.timeout(1_000) });

  // Every method has a parameters slot before its options, so a parameter
  // the API adds later is additive. One line per formerly options-only verb.
  const o = { timeout: 1_000 };
  await client.customers.delete("cus_1", {}, o);
  await client.prices.retrieve("price_1", {}, o);
  await client.checkoutSessions.retrieve("cs_1", {}, o);
  await client.oneShotPayments.retrieve("osp_1", {}, o);
  await client.subscriptions.pause("sub_1", {}, o);
  await client.subscriptions.resume("sub_1", {}, o);
  await client.subscriptions.reactivate("sub_1", {}, o);
  await client.subscriptions.retrieveUsageSummary("sub_1", {}, o);
  await client.refunds.retrieve("re_1", {}, o);
  await client.disputes.retrieve("dp_1", {}, o);
  await client.testClocks.retrieve("clock_1", {}, o);
  await client.testClocks.delete("clock_1", {}, o);
  await client.webhookEndpoints.listEventTypes({}, o);
  await client.webhookEndpoints.retrieve("we_1", {}, o);
  await client.webhookEndpoints.delete("we_1", {}, o);
  await client.webhookEndpoints.rotateSecret("we_1", {}, o);
  await client.webhookEndpoints.retrieveDelivery("we_1", "whd_1", {}, o);
  await client.webhookEndpoints.redeliver("we_1", "whd_1", {}, o);
  await client.events.retrieve("evt_1", {}, o);
  await client.tenant.retrieveCapabilities({}, o);
  await client.tenant.retrieveBillingProfile({}, o);
  await client.tenant.retrievePortalBranding({}, o);
  await client.tenant.export({}, o);
  await client.coupons.retrieve("co_1", {}, o);
  await client.taxRates.retrieve("txr_1", {}, o);
  await client.invoices.retrievePdf("in_1", {}, o);
  await client.invoices.sendEmail("in_1", {}, o);
  await client.creditNotes.retrieve("cn_1", {}, o);
  await client.creditNotes.retrievePdf("cn_1", {}, o);
  await client.auditLogs.retrieve("al_1", {}, o);
  await client.payments.retrieveProvider("pay_1", {}, o);
  await client.billingPortalSessions.revoke("bps_1", {}, o);
  await client.apiKeys.retrieve("ak_1", {}, o);
  await client.apiKeys.revoke("ak_1", {}, o);
  const none: EmptyParams = {};
  await client.invoices.sendEmail("in_1", none);
  // @ts-expect-error: EmptyParams admits no key at all.
  await client.invoices.sendEmail("in_1", { to: "a@b.co" });

  // @ts-expect-error: idempotencyKey moved to the options argument.
  await client.refunds.create({ payment_id: "pay_1", idempotencyKey: "refund-1" });

  // @ts-expect-error: purge needs an explicit confirmation.
  await client.customers.purge("cus_1");
  // @ts-expect-error: and it has to be `true`.
  await client.customers.purge("cus_1", { confirmed: false });
  await client.customers.purge("cus_1", { confirmed: true });

  // @ts-expect-error: removed in 1.0; use retrieveDelivery.
  void client.webhookEndpoints.getDelivery;
  // @ts-expect-error: renamed retrieveCapabilities in 1.0.
  void client.tenant.capabilities;

  await client.coupons.create({ code: "TEN", percent_off: 10 });
  await client.coupons.create({ code: "HALF", percent_off: 12.5 });

  // 1.0 names, before the contract was published.
  await client.customers.create({ email: "a@b.co", test_clock_id: "clock_1" });
  // @ts-expect-error: renamed test_clock_id.
  await client.customers.create({ email: "a@b.co", test_clock: "clock_1" });
  await client.checkoutSessions.create({
    price_id: "price_1",
    customer_email: "a@b.co",
    success_url: "https://x.example/ok",
    cancel_url: "https://x.example/no",
    payment_method: "ideal",
  });
  await client.oneShotPayments.create({
    customer_id: "cus_1",
    amount_cents: 500,
    currency: "EUR",
    success_url: "https://x.example/ok",
    // @ts-expect-error: renamed payment_method.
    method: "ideal",
  });
  // List filters that take several values are arrays.
  await client.events.list({ type: ["invoice.paid", "invoice.voided"] });
  await client.disputes.list({ status: ["open"] });
  // @ts-expect-error: a list filter, not a comma-joined string.
  await client.subscriptions.list({ renewal_state: "paused" });
  const dispute = await client.disputes.retrieve("dp_1");
  const reversedAt: number | null = dispute.reversed_at;
  void reversedAt;
  // @ts-expect-error: renamed reversed_at.
  void dispute.reversed;
  // @ts-expect-error: discount_value is gone from the API.
  await client.coupons.create({ code: "TEN", discount_type: "percent", discount_value: 10 });

  await client.prices.create({
    product_id: "prod_1",
    interval: "month",
    usage_type: "metered",
    billing_scheme: "tiered",
    tiers_mode: "graduated",
    tiers: [
      { up_to: 1000, unit_amount_cents: 1 },
      { up_to: "inf", unit_amount_decimal: "0.5" },
    ],
  });
  await client.prices.create({
    product_id: "prod_1",
    interval: "month",
    // @ts-expect-error: a decimal rate is a string, never a number.
    unit_amount_decimal: 0.02,
  });

  // A price says whether it follows the account's methods, and an update
  // takes null to make it follow them again.
  const price = await client.prices.update("price_1", { payment_methods: null });
  const fromAccount: boolean | undefined = price.payment_methods_from_account;
  void fromAccount;
}

// iter() takes exactly what list() takes.
assertType<Equal<Parameters<Customers["iter"]>, Parameters<Customers["list"]>>>();

// tsconfig.typetests.json turns on `exactOptionalPropertyTypes`, which the
// SDK's own build leaves off, so this file is compiled the way the
// strictest caller compiles theirs. Under it a value forwarded from the
// caller's own optional field is `T | undefined`, and every optional params
// field has to say it accepts that.
export async function exactOptionalCallers(opts: {
  limit?: number;
  cursor?: string;
  email?: string;
  expand?: Array<"stats">;
}): Promise<void> {
  await client.customers.list({
    limit: opts.limit,
    starting_after: opts.cursor,
    expand: opts.expand,
  });
  for await (const c of client.customers.iter({ limit: opts.limit })) void c;
  await client.customers.create({ email: opts.email });
  await client.products.retrieve("prod_1", { expand: undefined });
  await client.refunds.create({ payment_id: "pay_1", amount_cents: undefined });
}
