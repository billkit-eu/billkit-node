/**
 * Live-API harness for the node SDK integration suite.
 *
 * Talks to a real BillKit API booted with `BILLKIT_E2E_TEST_LOGIN=1`
 * (see `sdk/integration/boot-api.sh`). The whole suite is gated on
 * `BILLKIT_INTEGRATION_BASE_URL` and skips when it is unset, so a laptop
 * without a running stack keeps `make all-tests` green.
 *
 * Two env-gated API surfaces do the heavy lifting:
 *
 *  * `POST /v1/console/auth/_test/login` provisions a *fresh tenant* per
 *    unseen email and hands back a wildcard `api_key` plus the tenant's
 *    `mollie_route_id`. Every run uses a unique email, so a suite never
 *    inherits another run's rows and assertions on list endpoints stay
 *    meaningful.
 *  * `POST /v1/console/auth/_test/mollie/*` drives the in-process fake
 *    Mollie provider, which is what makes the money-path scenarios
 *    deterministic without touching real Mollie.
 */

import { randomUUID } from "node:crypto";

export const BASE_URL = process.env["BILLKIT_INTEGRATION_BASE_URL"] ?? "";

/** True when the suite has a live API to talk to. */
export const INTEGRATION_ENABLED = BASE_URL.length > 0;

export interface TestTenant {
  apiKey: string;
  tenantId: string;
  /** Path segment of `/internal/webhooks/mollie/{routeId}`. */
  mollieRouteId: string;
  operatorSessionToken: string;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return res;
}

/**
 * Provision a brand-new tenant and return its credentials.
 *
 * The email is randomised per call precisely so each suite/worker gets its
 * own tenant. List assertions ("exactly the 3 products I created") are only
 * stable under that isolation.
 */
export async function provisionTenant(label = "node-sdk-it"): Promise<TestTenant> {
  const email = `${label}-${randomUUID()}@sdk-it.example.com`;
  const res = await post("/v1/console/auth/_test/login", {
    email,
    mode: "test",
    tenant_name: `Node SDK IT ${label}`,
  });
  if (res.status === 404) {
    throw new Error(
      "test-login backdoor returned 404; boot the API with BILLKIT_E2E_TEST_LOGIN=1 " +
        "(see sdk/integration/boot-api.sh).",
    );
  }
  if (!res.ok) {
    throw new Error(`test-login failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    api_key: string;
    session_token: string;
    mollie_route_id: string;
    operator: { tenant_id: string };
  };
  return {
    apiKey: body.api_key,
    tenantId: body.operator.tenant_id,
    mollieRouteId: body.mollie_route_id,
    operatorSessionToken: body.session_token,
  };
}

/** Drive the in-process fake Mollie provider. */
export const mollie = {
  /**
   * Recover the provider payment id from a checkout session's Mollie URL.
   * The API never returns `tr_...` directly, but the fake encodes it in the
   * redirect URL, which keeps this per-checkout and free of shared state.
   */
  paymentIdFromCheckoutUrl(url: string): string {
    const id = url.split("/").pop() ?? "";
    if (!id.startsWith("tr_")) {
      throw new Error(`Expected a Mollie payment id in checkout URL, got: ${url}`);
    }
    return id;
  },

  async settle(paymentId: string, status: "paid" | "failed" | "expired" | "canceled" = "paid") {
    const res = await post("/v1/console/auth/_test/mollie/settle", {
      payment_id: paymentId,
      status,
    });
    if (!res.ok) throw new Error(`mollie settle failed: ${res.status} ${await res.text()}`);
  },

  async chargeback(paymentId: string, amountValue: string, reason?: string) {
    const res = await post("/v1/console/auth/_test/mollie/chargeback", {
      payment_id: paymentId,
      amount_value: amountValue,
      reason,
    });
    if (!res.ok) throw new Error(`mollie chargeback failed: ${res.status} ${await res.text()}`);
  },

  async refundStatus(refundId: string, status: "refunded" | "failed" = "refunded") {
    const res = await post("/v1/console/auth/_test/mollie/refund_status", {
      refund_id: refundId,
      status,
    });
    if (!res.ok) throw new Error(`mollie refund_status failed: ${res.status} ${await res.text()}`);
  },
};

/**
 * Post the provider webhook the way Mollie does, form-encoded `id=tr_...`.
 *
 * The API ignores the body's claims about state and re-fetches the payment
 * from the provider, so this call is only a *nudge*; `mollie.settle()` is
 * what actually decides the outcome. Driving it in that order is what makes
 * the money-path specs deterministic.
 */
export async function deliverMollieWebhook(routeId: string, providerPaymentId: string) {
  const res = await fetch(`${BASE_URL}/internal/webhooks/mollie/${routeId}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `id=${encodeURIComponent(providerPaymentId)}`,
  });
  if (!res.ok) {
    throw new Error(`mollie webhook delivery failed: ${res.status} ${await res.text()}`);
  }
}

/** Mint an API key with a restricted scope set, for the scope-denial spec. */
export async function mintScopedKey(tenant: TestTenant, scopes: string[]): Promise<string> {
  const res = await post(
    "/v1/api_keys",
    { label: `scoped-${randomUUID().slice(0, 8)}`, scopes },
    { authorization: `Bearer ${tenant.apiKey}` },
  );
  if (!res.ok) throw new Error(`api key mint failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { secret: string };
  return body.secret;
}

/** A fresh idempotency key. */
export function idemKey(): string {
  return `it-${randomUUID()}`;
}
