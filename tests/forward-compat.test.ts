/**
 * The API can add a response field, an enum value or an event type without
 * a new SDK. None of those may throw, and none may be dropped: the SDK hands
 * back the decoded JSON as it arrived. The types are open to match
 * (`"active" | ... | (string & {})`), and these tests pin the runtime half.
 */

import { describe, expect, it } from "vitest";

import { BillKit } from "../src/client.js";
import { FAST_RETRY, makeMockFetch } from "./helpers.js";

function client(fetchImpl: typeof fetch) {
  return new BillKit({
    apiKey: "bk_test_unit",
    baseUrl: "https://test.billkit.eu",
    retryPolicy: FAST_RETRY,
    fetch: fetchImpl,
  });
}

const FUTURE_SUBSCRIPTION = {
  id: "sub_1",
  object: "subscription",
  status: "hibernating",
  renewal_state: "orbiting",
  cancellation_reason: "moved_to_mars",
  a_field_from_2030: { nested: true, list: [1, 2, 3] },
};

describe("forward compatibility", () => {
  it("returns unknown fields and unknown enum values verbatim", async () => {
    const { fetchImpl } = makeMockFetch([{ status: 200, body: FUTURE_SUBSCRIPTION }]);
    const sub = await client(fetchImpl).subscriptions.retrieve("sub_1");
    expect(sub).toEqual(FUTURE_SUBSCRIPTION);
    // The open union accepts the value at the type level too.
    const status: typeof sub.status = "hibernating";
    expect(sub.status).toBe(status);
  });

  it("keeps unknown fields on list pages and on every row of an iter()", async () => {
    const { fetchImpl } = makeMockFetch([
      {
        status: 200,
        body: { object: "list", data: [FUTURE_SUBSCRIPTION], has_more: false, total_hint: 1 },
      },
      {
        status: 200,
        body: { object: "list", data: [FUTURE_SUBSCRIPTION], has_more: false },
      },
    ]);
    const c = client(fetchImpl);
    const page = await c.subscriptions.list();
    expect(page).toMatchObject({ total_hint: 1 });
    const rows = [];
    for await (const row of c.subscriptions.iter()) rows.push(row);
    expect(rows).toEqual([FUTURE_SUBSCRIPTION]);
  });

  it("returns an event of a type the SDK does not know", async () => {
    const event = {
      id: "evt_1",
      object: "event",
      type: "teleporter.calibrated",
      created: 1,
      livemode: false,
      data: { id: "tp_1" },
      previous_attributes: null,
    };
    const { fetchImpl } = makeMockFetch([{ status: 200, body: event }]);
    await expect(client(fetchImpl).events.retrieve("evt_1")).resolves.toEqual(event);
  });

  it("keeps previous_attributes null as null, and a set one as sent", async () => {
    const created = { id: "evt_1", object: "event", type: "customer.created", previous_attributes: null };
    const updated = {
      id: "evt_2",
      object: "event",
      type: "subscription.updated",
      previous_attributes: { renewal_state: "auto_renew" },
    };
    const { fetchImpl } = makeMockFetch([
      { status: 200, body: created },
      { status: 200, body: updated },
    ]);
    const c = client(fetchImpl);
    const first = await c.events.retrieve("evt_1");
    const second = await c.events.retrieve("evt_2");
    expect(first.previous_attributes).toBeNull();
    expect("previous_attributes" in first).toBe(true);
    expect(second.previous_attributes).toEqual({ renewal_state: "auto_renew" });
  });
});
