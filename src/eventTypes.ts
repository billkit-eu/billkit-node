/**
 * Every event type BillKit can deliver, as constants.
 *
 * Generated from the API's catalogue (`api/billkit/core/events.py`) and
 * checked against it in both directions by `api/tests/test_sdk_event_constants.py`,
 * so a type the API adds or drops fails the monorepo build until this copy
 * follows. Use them to subscribe an endpoint and to route a delivery
 * without a typo that would never match:
 *
 *     if (event.type === EventTypes.INVOICE_PAID) { ... }
 *
 * The list describes the API this SDK version was built against, nothing
 * more. A newer API can deliver a type this list does not name, so a
 * webhook handler must treat an unknown `type` as "ignore", never as an
 * error. Nothing in the SDK rejects one: `verifyWebhookSignature`
 * does not look at `type` at all.
 */
import type { UnknownWebhookEvent, WebhookEvent } from "./generated/models.js";

export const EventTypes = {
  // Checkout
  CHECKOUT_SESSION_COMPLETED: "checkout.session.completed",
  CHECKOUT_SESSION_EXPIRED: "checkout.session.expired",
  // Customer
  CUSTOMER_CREATED: "customer.created",
  CUSTOMER_UPDATED: "customer.updated",
  CUSTOMER_DELETED: "customer.deleted",
  // Subscription lifecycle
  SUBSCRIPTION_CREATED: "subscription.created",
  SUBSCRIPTION_UPDATED: "subscription.updated",
  SUBSCRIPTION_CANCELED: "subscription.canceled",
  SUBSCRIPTION_PAST_DUE: "subscription.past_due",
  SUBSCRIPTION_PAUSED: "subscription.paused",
  SUBSCRIPTION_RESUMED: "subscription.resumed",
  SUBSCRIPTION_REACTIVATED: "subscription.reactivated",
  SUBSCRIPTION_PLAN_CHANGED: "subscription.plan_changed",
  SUBSCRIPTION_TRIAL_STARTED: "subscription.trial_started",
  SUBSCRIPTION_TRIAL_WILL_END: "subscription.trial_will_end",
  SUBSCRIPTION_TRIAL_ENDED: "subscription.trial_ended",
  SUBSCRIPTION_PAYMENT_METHOD_UPDATED: "subscription.payment_method_updated",
  SUBSCRIPTION_COUPON_APPLIED: "subscription.coupon_applied",
  SUBSCRIPTION_COUPON_EXPIRED: "subscription.coupon_expired",
  // Payments
  PAYMENT_SUCCEEDED: "payment.succeeded",
  PAYMENT_FAILED: "payment.failed",
  ONE_SHOT_PAYMENT_SUCCEEDED: "one_shot_payment.succeeded",
  ONE_SHOT_PAYMENT_FAILED: "one_shot_payment.failed",
  ONE_SHOT_PAYMENT_REFUNDED: "one_shot_payment.refunded",
  // Refunds and disputes
  REFUND_CREATED: "refund.created",
  REFUND_SUCCEEDED: "refund.succeeded",
  REFUND_FAILED: "refund.failed",
  DISPUTE_CREATED: "dispute.created",
  DISPUTE_CLOSED: "dispute.closed",
  // Documents
  INVOICE_CREATED: "invoice.created",
  INVOICE_UPCOMING: "invoice.upcoming",
  INVOICE_PAID: "invoice.paid",
  INVOICE_PAYMENT_FAILED: "invoice.payment_failed",
  INVOICE_VOIDED: "invoice.voided",
  INVOICE_MARKED_UNCOLLECTIBLE: "invoice.marked_uncollectible",
  CREDIT_NOTE_CREATED: "credit_note.created",
  // Catalogue
  PRODUCT_CREATED: "product.created",
  PRODUCT_UPDATED: "product.updated",
  PRODUCT_ARCHIVED: "product.archived",
  PRICE_CREATED: "price.created",
  PRICE_UPDATED: "price.updated",
  PRICE_ARCHIVED: "price.archived",
  COUPON_CREATED: "coupon.created",
  COUPON_UPDATED: "coupon.updated",
  // Endpoint management
  WEBHOOK_ENDPOINT_CREATED: "webhook_endpoint.created",
  WEBHOOK_ENDPOINT_UPDATED: "webhook_endpoint.updated",
  WEBHOOK_ENDPOINT_DELETED: "webhook_endpoint.deleted",
  // Operational
  DUNNING_EMAIL_REQUIRED: "dunning.email_required",
} as const;

/** One of the event types in {@link EventTypes}. */
export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

/** Every value of {@link EventTypes}, for subscribing an endpoint to a set. */
export const EVENT_TYPES: readonly EventType[] = Object.freeze(Object.values(EventTypes));

const KNOWN: ReadonlySet<string> = new Set(EVENT_TYPES);

/**
 * Whether this SDK version knows an event, or an event type. A `false` is
 * not an error: it usually means the API is newer than the SDK, and the
 * delivery should be acknowledged and ignored.
 *
 * Given a verified event it narrows `WebhookEvent | UnknownWebhookEvent` to
 * {@link WebhookEvent}, the union discriminated on `type`, so a `switch`
 * inside it types `event.data` per case:
 *
 * ```ts
 * const event = await verifyWebhookSignature({ payload, signatureHeader, secret });
 * if (!isKnownEventType(event)) return; // newer than this SDK: acknowledge it
 * switch (event.type) {
 *   case "invoice.paid":
 *     await markPaid(event.data.id); // event.data is an Invoice
 *     break;
 * }
 * ```
 *
 * Any other object with a `type` (an `Event` from `events.list`) narrows
 * to one whose `type` is an {@link EventType}; a string narrows to
 * {@link EventType}.
 */
export function isKnownEventType(
  event: WebhookEvent | UnknownWebhookEvent,
): event is WebhookEvent;
export function isKnownEventType<E extends { readonly type: string }>(
  event: E,
): event is E & { type: EventType };
export function isKnownEventType(type: string): type is EventType;
export function isKnownEventType(input: string | { readonly type: string }): boolean {
  const type = typeof input === "string" ? input : (input as { type?: unknown } | null)?.type;
  return typeof type === "string" && KNOWN.has(type);
}
