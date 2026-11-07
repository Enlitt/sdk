import { describe, expect, it } from "vitest";

import {
  ADMIN_COMMAND_NAMES,
  adminCommandKind,
  validateAdminActionErrorResponse,
  validateAdminActionRequest,
  validateAdminActionResponse,
  type AdminCommandName
} from "../src/admin.js";
import { ENLITT_ERROR_CODES } from "../src/errors.js";
import {
  CHANGE_MODES,
  PAYOUT_BLOCKED_REASONS,
  REFUND_REASONS,
  validateRedeemGiftCodeRequest
} from "../src/dashboard.js";
import { ENLITT_API_VERSION } from "../src/compatibility.js";

const ACTION_ID = "123e4567-e89b-42d3-a456-426614174000";

/** One valid args object per command, mirroring the PROTOCOLS.md table. */
const VALID_ARGS: Record<AdminCommandName, Record<string, unknown>> = {
  "inspect.user": { email: "a@example.com" },
  "inspect.business": { id: "biz_1" },
  "inspect.app": { id: "app_1" },
  "inspect.order": { id: "ord_1" },
  "inspect.call": { id: "call_1" },
  "inspect.txn": { id: "txn_1" },
  sql: { sql: "select 1", limit: 10 },
  log: { operator: "alice", target_id: "usr_1", limit: 5, cursor: "c" },
  "report.platform": { days: 30 },
  "refund.cash": { order_id: "ord_1", amount_minor_units: null },
  "refund.manual": { order_id: "ord_1", amount_minor_units: "500" },
  "refund.mark_paid": { transaction_id: "txn_1", bank_reference: "REF" },
  "refund.cancel_manual": { transaction_id: "txn_1" },
  "credits.grant": { user_id: "usr_1", standard_units: "1000", premium_units: "0", call_id: null },
  "plan.set": { user_id: "usr_1", plan_id: "pro", catalog_version: "v1" },
  "plan.reset": { user_id: "usr_1" },
  "status.suspend": { subject: "user", id: "usr_1", days: null },
  "status.unsuspend": { subject: "app", id: "app_1" },
  "payout.block": { business_id: "biz_1" },
  "payout.unblock": { business_id: "biz_1" },
  "payout.create": { business_id: "biz_1", nano_usd: "50000000000" },
  "payout.execute": { transaction_id: "txn_1" },
  "gift.create": {
    product_kind: "bundle",
    product_id: "b1",
    catalog_version: "v1",
    expires_at: null
  },
  "gift.revoke": { gift_code_id: "g1" },
  "account.set_email": { auth_user_id: "au_1", email: "a@example.com" },
  "account.release_phone": { user_id: "usr_1" },
  "account.set_app_limits": {
    user_id: "u",
    application_id: "a",
    limits: { premium_per_call: "0" }
  },
  "account.set_default_limit": { user_id: "u", premium_per_call: "5000" }
};

function request(command: AdminCommandName, args: unknown, extra: Record<string, unknown> = {}) {
  return { action_id: ACTION_ID, command, args, reason: "because", ...extra };
}

describe("admin request validators", () => {
  it("covers every command in the table", () => {
    expect(Object.keys(VALID_ARGS).sort()).toEqual([...ADMIN_COMMAND_NAMES].sort());
  });

  for (const command of ADMIN_COMMAND_NAMES) {
    describe(command, () => {
      const args = VALID_ARGS[command];
      it("accepts its documented args", () => {
        expect(validateAdminActionRequest(request(command, args)).ok).toBe(true);
      });
      it("refuses an unknown field", () => {
        expect(validateAdminActionRequest(request(command, { ...args, extra: 1 }))).toMatchObject({
          ok: false,
          error: { code: "unsupported_parameter" }
        });
      });
      it("refuses a missing required field", () => {
        const required = Object.keys(args).filter(
          (key) => !["limit", "cursor", "operator", "target_id", "days"].includes(key)
        );
        // Commands whose only args are optional (log) have nothing to drop.
        for (const key of required) {
          const { [key]: _dropped, ...rest } = args;
          const result = validateAdminActionRequest(request(command, rest));
          // inspect.user/business swap id and email, so dropping the only one fails too.
          expect(result.ok).toBe(false);
        }
      });
    });
  }

  it("refuses a float or signed amount", () => {
    for (const bad of [5, "1.5", "-1", "01", 1.5]) {
      expect(
        validateAdminActionRequest(
          request("refund.manual", { order_id: "o", amount_minor_units: bad })
        ).ok
      ).toBe(false);
      expect(
        validateAdminActionRequest(
          request("credits.grant", { ...VALID_ARGS["credits.grant"], standard_units: bad })
        ).ok
      ).toBe(false);
    }
  });

  it("requires a reason for writes only", () => {
    expect(
      validateAdminActionRequest(request("plan.reset", VALID_ARGS["plan.reset"], { reason: null }))
        .ok
    ).toBe(false);
    expect(
      validateAdminActionRequest(request("plan.reset", VALID_ARGS["plan.reset"], { reason: "" })).ok
    ).toBe(false);
    expect(
      validateAdminActionRequest(
        request("plan.reset", VALID_ARGS["plan.reset"], { reason: "x".repeat(1001) })
      ).ok
    ).toBe(false);
    expect(
      validateAdminActionRequest(
        request("inspect.app", VALID_ARGS["inspect.app"], { reason: null })
      ).ok
    ).toBe(true);
    expect(adminCommandKind("sql")).toBe("read");
    expect(adminCommandKind("gift.create")).toBe("write");
  });

  it("refuses unknown top-level fields, a bad action id, and an unknown command", () => {
    expect(
      validateAdminActionRequest(request("sql", VALID_ARGS.sql, { idempotency: "x" })).ok
    ).toBe(false);
    expect(
      validateAdminActionRequest({ ...request("sql", VALID_ARGS.sql), action_id: "nope" }).ok
    ).toBe(false);
    expect(
      validateAdminActionRequest({ ...request("sql", VALID_ARGS.sql), command: "drop" }).ok
    ).toBe(false);
  });

  it("enforces exactly one of id and email, and numeric bounds", () => {
    expect(
      validateAdminActionRequest(request("inspect.user", { id: "u", email: "e@x.co" })).ok
    ).toBe(false);
    expect(validateAdminActionRequest(request("sql", { sql: "select 1", limit: 1001 })).ok).toBe(
      false
    );
    expect(
      validateAdminActionRequest(
        request("status.suspend", { subject: "user", id: "u", days: 3651 })
      ).ok
    ).toBe(false);
    expect(
      validateAdminActionRequest(request("status.suspend", { subject: "user", id: "u", days: 1.5 }))
        .ok
    ).toBe(false);
    for (const days of [0, 91, 7.5, "7"]) {
      expect(validateAdminActionRequest(request("report.platform", { days })).ok).toBe(false);
    }
    expect(validateAdminActionRequest(request("report.platform", {})).ok).toBe(true);
  });
});

describe("admin responses", () => {
  const success = {
    action_id: ACTION_ID,
    command: "payout.create",
    status: "succeeded",
    replayed: false,
    result: { transaction_id: "t", nano_usd: "5", status: "pending" }
  };

  it("reads a success body and rejects unknown fields strictly but not tolerantly", () => {
    expect(validateAdminActionResponse(success).ok).toBe(true);
    const extra = { ...success, result: { ...success.result, future: 1 } };
    expect(validateAdminActionResponse(extra).ok).toBe(false);
    expect(validateAdminActionResponse(extra, { mode: "tolerant" })).toMatchObject({
      ok: true,
      value: { result: { transaction_id: "t" } }
    });
  });

  it("reads the status.suspend billing summary, null for a business or app", () => {
    const suspend = (billing: unknown) => ({
      ...success,
      command: "status.suspend",
      result: { subject: "user", id: "u", status: "suspended", suspended_until: null, billing }
    });
    const billing = {
      refunds: [
        { order_id: "o1", outcome: "refunded", refund_minor_units: "1500", reason: "unused" },
        { order_id: "o2", outcome: "ineligible", refund_minor_units: "0", reason: "window_expired" }
      ],
      subscription_canceled: true
    };
    expect(validateAdminActionResponse(suspend(billing)).ok).toBe(true);
    expect(validateAdminActionResponse(suspend(null)).ok).toBe(true);
    expect(
      validateAdminActionResponse(
        suspend({ ...billing, refunds: [{ ...billing.refunds[0], outcome: "paid" }] })
      ).ok
    ).toBe(false);
  });

  it("reads a platform report, with signed values and null on snapshot rows", () => {
    const report = (row: Record<string, unknown>) => ({
      ...success,
      command: "report.platform",
      result: {
        environment: "production",
        window_start: "2026-10-16T13:00:00.000Z",
        window_end: "2026-10-23T13:00:00.000Z",
        sections: [{ title: "Costs and margin", rows: [row] }]
      }
    });
    const margin = { label: "Estimated margin", unit: "nano_usd", window: "-5", total: "10" };
    expect(validateAdminActionResponse(report(margin)).ok).toBe(true);
    expect(validateAdminActionResponse(report({ ...margin, window: null })).ok).toBe(true);
    for (const bad of ["-0", "01", "1.5", 5]) {
      expect(validateAdminActionResponse(report({ ...margin, total: bad })).ok).toBe(false);
    }
    expect(validateAdminActionResponse(report({ ...margin, unit: "euros" })).ok).toBe(false);
  });

  it("reads the error envelope", () => {
    const body = {
      error: { code: "admin_authentication_required", message: "m" },
      request_id: "r"
    };
    expect(validateAdminActionErrorResponse(body).ok).toBe(true);
    expect(validateAdminActionErrorResponse({ ...body, action_id: ACTION_ID }).ok).toBe(true);
    expect(validateAdminActionErrorResponse({ error: {} }).ok).toBe(false);
  });
});

describe("admin-related dashboard and error vocabulary", () => {
  it("maps admin_authentication_required to 401", () => {
    expect(ENLITT_ERROR_CODES.admin_authentication_required).toMatchObject({
      type: "authentication_error",
      status: 401,
      retryable: false
    });
  });
  it("accepts the new enum members", () => {
    expect(CHANGE_MODES).toContain("locked");
    expect(PAYOUT_BLOCKED_REASONS).toContain("payout_blocked");
    expect(REFUND_REASONS).toContain("gift");
    expect(ENLITT_API_VERSION).toBe("2026-10-05");
  });
  it("accepts only { code } for gift redemption", () => {
    expect(validateRedeemGiftCodeRequest({ code: "ABCD-1234" }).ok).toBe(true);
    expect(validateRedeemGiftCodeRequest({ code: "" }).ok).toBe(false);
    expect(validateRedeemGiftCodeRequest({ code: "x".repeat(65) }).ok).toBe(false);
    expect(validateRedeemGiftCodeRequest({ code: "a", extra: 1 }).ok).toBe(false);
    expect(validateRedeemGiftCodeRequest({}).ok).toBe(false);
  });
});
