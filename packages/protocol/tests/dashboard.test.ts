import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  BUSINESS_PERMISSIONS,
  BUSINESS_ROLE_NAMES,
  validateApiKeyMetadata,
  validateApiKeyMetadataList,
  validateApplicationCostProfile,
  premiumUnitsHistogramBinCount,
  validateBusinessAccess,
  validateBusinessApplicationDetail,
  validateBusinessApplicationPremiumRequest,
  validateBusinessApplicationInfo,
  validateBusinessLoginEmailChallenge,
  validateBusinessDashboardInfo,
  validateBusinessPayoutList,
  validateBusinessInvitationRequest,
  validateBusinessInvitationResult,
  validateBusinessMemberList,
  validateBusinessPermission,
  validateBusinessRole,
  validateChangeBusinessMemberRoleRequest,
  validateConsentCompletionRequest,
  validateConsentInfo,
  validateCreateBusinessApplicationRequest,
  validateCreateBusinessRequest,
  validateCreateBusinessKeyRequest,
  validateCreateBusinessKeyResponse,
  validateCreateBusinessPayoutRequest,
  validateCreditsCheckoutRequest,
  validateDashboardCheckoutResponse,
  validateCreditsCheckoutResponse,
  validateEmailSignInCompleted,
  validateEmailSignInSent,
  validatePaymentMethodSetupResponse,
  validateDashboardPurchaseOrderPage,
  validatePersonalPeriodPage,
  validateDashboardPurchaseOrderSummary,
  validateEmptyRequestBody,
  validatePatchPersonalApplicationLimitRequest,
  validatePatchPersonalSettingsRequest,
  validatePersonalApplicationDetail,
  validatePersonalApplicationsPage,
  validatePersonalApplicationCallPage,
  validatePersonalApplicationCallsQuery,
  validatePersonalDashboard,
  validateSelectActiveBusinessRequest,
  validateStartBusinessLoginEmailChangeRequest,
  validateStartContactVerificationRequest,
  validateSubscriptionPlanCatalog,
  validateSubscriptionSelectionRequest,
  validateTransferBusinessOwnershipRequest,
  validateUpdateBusinessApplicationRequest,
  validateVerifyBusinessLoginEmailChangeRequest
} from "../src/dashboard.js";

describe("dashboard response compatibility", () => {
  it("keeps response parsing strict by default and drops added fields in tolerant mode", () => {
    const checkout = { transaction_id: "txn_1", redirect_url: "https://pay.example.com/x", future: true };
    expect(validateDashboardCheckoutResponse(checkout)).toMatchObject({
      ok: false,
      error: { param: "body.future" }
    });
    expect(validateDashboardCheckoutResponse(checkout, { mode: "tolerant" })).toMatchObject({
      ok: true,
      value: { transaction_id: "txn_1", redirect_url: "https://pay.example.com/x" }
    });

    expect(
      validatePaymentMethodSetupResponse(
        { client_secret: "secret", future: true },
        { mode: "tolerant" }
      )
    ).toMatchObject({ ok: true, value: { client_secret: "secret" } });
  });

  it("maps future closed response enum members to other without relaxing request validators", () => {
    const key = validateApiKeyMetadata(
      { ...API_KEY_MODEL, status: "rotating", future: true },
      "key",
      { mode: "tolerant" }
    );
    expect(key).toMatchObject({ ok: true, value: { status: "other" } });
    if (key.ok) expect(key.value).not.toHaveProperty("future");

    expect(validateEmailSignInSent({ status: "queued", resend_after_seconds: 10 }, { mode: "tolerant" })).toMatchObject({
      ok: true,
      value: { status: "other", resend_after_seconds: 10 }
    });
    expect(
      validateEmailSignInCompleted(
        {
          status: "signed_in",
          account_type: "partner",
          registered: false,
          phone_verification_required: false
        },
        { mode: "tolerant" }
      )
    ).toMatchObject({
      ok: true,
      value: {
        status: "signed_in",
        account_type: "other",
        registered: false,
        phone_verification_required: false
      }
    });
  });
});

const BUSINESS_ACCESS = {
  login: { email: "owner@example.com" },
  owns_business: true,
  active_business: {
    id: "biz_1",
    name: "Acme",
    created_at: "2026-01-02T03:04:05.000Z",
    role: "owner",
    permissions: [...BUSINESS_PERMISSIONS]
  },
  businesses: [{ id: "biz_1", name: "Acme", role: "owner", status: "active" }],
  pending_invitations: [
    {
      id: "invite_1",
      business_id: "biz_1",
      business_name: "Acme",
      role: "developer",
      invited_by_email: "owner@example.com",
      expires_at: "2026-10-01T00:00:00Z"
    }
  ]
};

const BUSINESS_MEMBER_LIST = {
  owner: { email: "owner@example.com", is_you: true },
  members: [
    {
      id: "member_1",
      email: "developer@example.com",
      role: "developer",
      joined_at: "2026-09-01T00:00:00Z",
      is_you: false
    }
  ],
  invitations: [
    {
      id: "invite_1",
      email: "viewer@example.com",
      role: "viewer",
      invited_by_email: "owner@example.com",
      created_at: "2026-09-29T00:00:00Z",
      expires_at: "2026-10-01T00:00:00Z"
    }
  ]
};

describe("business access and membership wire contracts", () => {
  it("exports and validates the complete permission and role vocabulary", () => {
    expect(BUSINESS_PERMISSIONS).toEqual([
      "stats.view",
      "apps.manage",
      "keys.manage",
      "payouts.manage",
      "payout_billing.manage",
      "members.manage",
      "premium.manage",
      "ownership.transfer"
    ]);
    expect(BUSINESS_ROLE_NAMES).toEqual(["owner", "admin", "developer", "viewer"]);
    expect(validateBusinessPermission("stats.view").ok).toBe(true);
    expect(validateBusinessPermission("unknown").ok).toBe(false);
    expect(validateBusinessPermission("unknown", "permission", { mode: "tolerant" })).toMatchObject({
      ok: true,
      value: "other"
    });
    expect(validateBusinessRole("owner").ok).toBe(true);
    expect(validateBusinessRole("operator").ok).toBe(false);
  });

  it("validates BusinessAccess strictly and reads a future role tolerantly", () => {
    expect(validateBusinessAccess(BUSINESS_ACCESS).ok).toBe(true);
    expect(
      validateBusinessAccess({
        ...BUSINESS_ACCESS,
        active_business: {
          ...BUSINESS_ACCESS.active_business,
          permissions: ["apps.manage", "stats.view"]
        }
      }).ok
    ).toBe(false);
    expect(validateBusinessAccess({ ...BUSINESS_ACCESS, extra: true }).ok).toBe(false);
    const future = {
      ...BUSINESS_ACCESS,
      active_business: { ...BUSINESS_ACCESS.active_business, role: "operator", future: true }
    };
    expect(validateBusinessAccess(future, { mode: "tolerant" })).toMatchObject({
      ok: true,
      value: { active_business: { role: "other" } }
    });
  });

  it("validates member-list and invitation responses and never permits owner as an assignable role", () => {
    expect(validateBusinessMemberList(BUSINESS_MEMBER_LIST).ok).toBe(true);
    expect(
      validateBusinessInvitationResult({ invitation: BUSINESS_MEMBER_LIST.invitations[0], email_delivery: "failed" }).ok
    ).toBe(true);
    expect(
      validateBusinessMemberList({
        ...BUSINESS_MEMBER_LIST,
        members: [{ ...BUSINESS_MEMBER_LIST.members[0], role: "owner" }]
      }).ok
    ).toBe(false);
  });

  it("validates application presentation as an allowlisted response shape", () => {
    expect(validateBusinessApplicationInfo({ icon_url: "https://cdn.example.com/icon.png" })).toMatchObject({
      ok: true,
      value: { icon_url: "https://cdn.example.com/icon.png" }
    });
    expect(validateBusinessApplicationInfo({ description: "Acme", extra: true }).ok).toBe(false);
    expect(
      validateBusinessApplicationInfo({ description: "Acme", extra: true }, "info", { mode: "tolerant" })
    ).toMatchObject({ ok: true, value: { description: "Acme" } });
  });

  it("keeps all membership mutation bodies strict and disallows owner assignment", () => {
    expect(validateCreateBusinessRequest({ name: "  Acme  " })).toMatchObject({ ok: true, value: { name: "Acme" } });
    expect(validateCreateBusinessRequest({ name: "Acme", extra: true }).ok).toBe(false);
    expect(validateSelectActiveBusinessRequest({ business_id: "biz_1" }).ok).toBe(true);
    expect(validateBusinessInvitationRequest({ email: "member@example.com", role: "developer" }).ok).toBe(true);
    expect(validateBusinessInvitationRequest({ email: "member@example.com", role: "owner" }).ok).toBe(false);
    expect(validateChangeBusinessMemberRoleRequest({ role: "owner" }).ok).toBe(false);
    expect(validateTransferBusinessOwnershipRequest({ member_id: "member_1" }).ok).toBe(true);
  });

  it("shapes the business sign-in email change bodies", () => {
    expect(
      validateStartBusinessLoginEmailChangeRequest({ email: "owner@example.com", turnstile_token: "token" }).ok
    ).toBe(true);
    expect(
      validateStartBusinessLoginEmailChangeRequest({ email: "owner@example.com", turnstile_token: "t", extra: 1 }).ok
    ).toBe(false);
    expect(validateStartBusinessLoginEmailChangeRequest({ email: "not-an-email", turnstile_token: "t" }).ok).toBe(
      false
    );
    expect(validateBusinessLoginEmailChallenge({ challenge_id: "c1", resend_after_seconds: 30 }).ok).toBe(true);
    expect(validateBusinessLoginEmailChallenge({ challenge_id: "c1" }).ok).toBe(false);
    expect(validateVerifyBusinessLoginEmailChangeRequest({ challenge_id: "c1", code: "123456" }).ok).toBe(true);
    expect(validateVerifyBusinessLoginEmailChangeRequest({ challenge_id: "c1", code: "123456", x: 1 }).ok).toBe(false);
  });

});

const PLAN_SUMMARY = {
  id: "plan_free",
  display_name: "Free",
  is_free: true,
  price_minor_units: "0",
  currency: "USD",
  interval: "month",
  catalog_version: "2026-01-01"
};

function personalDashboard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account: { id: "acct_1", type: "user", email: "a@example.com" },
    usage: {
      period_start: "2026-01-01T00:00:00Z",
      period_end: "2026-02-01T00:00:00Z",
      plan: PLAN_SUMMARY,
      standard: { used: "0", reserved: "0", limit: null, service_tier: "normal" },
      premium: { used: "0", reserved: "0", limit: "1000000000" }
    },
    extra_credits: {
      standard: { remaining: "0", reserved: "0" },
      premium: { remaining: "0", reserved: "0" }
    },
    settings: { new_application_premium_per_call_limit: "500000" },
    subscription: { status: "active", plan: PLAN_SUMMARY, change_mode: "change" },
    ...overrides
  };
}

describe("validatePersonalDashboard", () => {
  it("accepts the documented shape", () => {
    const result = validatePersonalDashboard(personalDashboard());
    expect(result.ok).toBe(true);
  });

  it("rejects a renamed field even though the structure otherwise matches", () => {
    const body = personalDashboard();
    const settings = body.settings as Record<string, unknown>;
    delete settings.new_application_premium_per_call_limit;
    settings.default_premium_per_call_limit = "500000";
    const result = validatePersonalDashboard(body);
    expect(result.ok).toBe(false);
  });

  it("requires usage to be null exactly when subscription.status is suspended", () => {
    const suspended = personalDashboard({
      usage: null,
      extra_credits: null,
      subscription: { status: "suspended", change_mode: "unavailable" }
    });
    expect(validatePersonalDashboard(suspended).ok).toBe(true);

    const activeWithNullUsage = personalDashboard({ usage: null });
    expect(validatePersonalDashboard(activeWithNullUsage).ok).toBe(false);

    const suspendedWithPlan = personalDashboard({
      usage: null,
      subscription: { status: "suspended", change_mode: "unavailable", plan: PLAN_SUMMARY }
    });
    expect(validatePersonalDashboard(suspendedWithPlan).ok).toBe(false);
  });

  it("accepts locked_downgrade only alongside change_mode locked, and only its two members", () => {
    for (const mode of ["checkout", "change"] as const) {
      const locked = personalDashboard({
        subscription: { status: "active", plan: PLAN_SUMMARY, change_mode: "locked", locked_downgrade: mode }
      });
      const result = validatePersonalDashboard(locked);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.subscription.locked_downgrade).toBe(mode);
    }
    // Optional: a locked subscription without it validates and carries none.
    const lockedWithout = validatePersonalDashboard(
      personalDashboard({ subscription: { status: "active", plan: PLAN_SUMMARY, change_mode: "locked" } })
    );
    expect(lockedWithout.ok).toBe(true);
    if (lockedWithout.ok) expect("locked_downgrade" in lockedWithout.value.subscription).toBe(false);
    // Any other known mode refuses it.
    const withChange = personalDashboard({
      subscription: { status: "active", plan: PLAN_SUMMARY, change_mode: "change", locked_downgrade: "change" }
    });
    expect(validatePersonalDashboard(withChange).ok).toBe(false);
  });

  it("preserves a NANOUSD amount above Number.MAX_SAFE_INTEGER as a string", () => {
    const huge = "9007199254740993000";
    const body = personalDashboard();
    (body.usage as Record<string, unknown> & { premium: Record<string, unknown> }).premium.limit =
      huge;
    const result = validatePersonalDashboard(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.usage?.premium.limit).toBe(huge);
      expect(typeof result.value.usage?.premium.limit).toBe("string");
    }
  });

  it("rejects a non-canonical amount string", () => {
    const body = personalDashboard();
    (body.usage as Record<string, unknown> & { premium: Record<string, unknown> }).premium.limit =
      "01";
    expect(validatePersonalDashboard(body).ok).toBe(false);
  });

  it("rejects unknown response fields in strict mode at every nested depth", () => {
    const body = personalDashboard({ extra_field: true });
    expect(validatePersonalDashboard(body)).toMatchObject({
      ok: false,
      error: { param: "body.extra_field" }
    });

    const nested = personalDashboard();
    ((nested.usage as Record<string, unknown>).plan as Record<string, unknown>).future_field = true;
    expect(validatePersonalDashboard(nested)).toMatchObject({
      ok: false,
      error: { param: "body.usage.plan.future_field" }
    });
  });

  it("drops future fields and maps closed response enums in tolerant mode", () => {
    const body = personalDashboard({ extra_field: true });
    const usage = body.usage as Record<string, unknown>;
    const plan = usage.plan as Record<string, unknown>;
    plan.interval = "quarter";
    plan.future_field = true;
    const subscription = body.subscription as Record<string, unknown>;
    subscription.status = "paused";

    const result = validatePersonalDashboard(body, { mode: "tolerant" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toHaveProperty("extra_field");
      expect(result.value.usage?.plan).not.toHaveProperty("future_field");
      expect(result.value.usage?.plan.interval).toBe("other");
      expect(result.value.subscription.status).toBe("other");
    }
  });
});

describe("validatePatchPersonalSettingsRequest", () => {
  it("accepts the one documented field", () => {
    const result = validatePatchPersonalSettingsRequest({
      new_application_premium_per_call_limit: "0"
    });
    expect(result.ok).toBe(true);
  });

  it("accepts an empty body", () => {
    expect(validatePatchPersonalSettingsRequest({}).ok).toBe(true);
  });

  it("rejects any other field", () => {
    const result = validatePatchPersonalSettingsRequest({ email: "new@example.com" });
    expect(result.ok).toBe(false);
  });
});

describe("validatePersonalApplicationsPage / validatePersonalApplicationDetail", () => {
  const limits = { standard_per_call: "10000", premium_per_call: "1000", rate: { standard: { credits: "500", period_minutes: 60 }, premium: { credits: "200", period_minutes: 1440 } } };
  const summary = {
    id: "app_1",
    name: "My App",
    business_display_name: "Biz",
    environment: "test",
    limits,
    authorized_at: "2026-01-01T00:00:00Z",
    last_authorized_at: "2026-01-02T00:00:00Z",
    revoked_at: null
  };
  const totals = { standard_requests: 2, premium_requests: 0, standard_units_used: "1500", premium_units_used: "0" };
  const item = { ...summary, totals };
  const range = { from: "2026-01-01T00:00:00Z", to: "2026-01-31T00:00:00Z", timezone: "UTC" };
  const pageOf = (applications: unknown[]) => ({ applications, range, next_cursor: null });

  it("accepts the documented application list wrapper", () => {
    const result = validatePersonalApplicationsPage(pageOf([item]));
    expect(result.ok).toBe(true);
  });

  it("carries the presentation fields only when set and requires business_display_name", () => {
    const withOptional = { ...item, icon_url: "https://x.example/i.png", description: "d" };
    const ok = validatePersonalApplicationsPage(pageOf([withOptional]));
    expect(ok).toMatchObject({ ok: true, value: { applications: [{ icon_url: "https://x.example/i.png", description: "d" }] } });
    const bare = validatePersonalApplicationsPage(pageOf([item]));
    expect(bare.ok && "icon_url" in bare.value.applications[0]!).toBe(false);
    const nullIcon = { ...item, icon_url: null };
    expect(validatePersonalApplicationsPage(pageOf([nullIcon])).ok).toBe(false);
    const { business_display_name: _omitted, ...missing } = item;
    expect(validatePersonalApplicationsPage(pageOf([missing])).ok).toBe(false);
  });

  it("carries revoked_at as an instant or null and requires it to be present", () => {
    const revoked = { ...item, revoked_at: "2026-02-01T00:00:00Z" };
    expect(validatePersonalApplicationsPage(pageOf([revoked]))).toMatchObject({
      ok: true,
      value: { applications: [{ revoked_at: "2026-02-01T00:00:00Z" }] }
    });
    const { revoked_at: _omitted, ...missing } = item;
    expect(validatePersonalApplicationsPage(pageOf([missing])).ok).toBe(false);
    expect(validatePersonalApplicationsPage(pageOf([{ ...item, revoked_at: "yesterday" }])).ok).toBe(false);
  });

  it("rejects a zero rate period", () => {
    const zero = { ...item, limits: { ...limits, rate: { ...limits.rate, premium: { credits: "1", period_minutes: 0 } } } };
    expect(validatePersonalApplicationsPage(pageOf([zero])).ok).toBe(false);
  });

  it("rejects the legacy premium_per_call_limit in place of limits", () => {
    const { limits: _limits, ...rest } = item;
    const legacy = { ...rest, premium_per_call_limit: "1000" };
    expect(validatePersonalApplicationsPage(pageOf([legacy])).ok).toBe(false);
  });

  it("tolerates future limits keys in tolerant mode only and rejects a malformed rate", () => {
    const future = { ...item, limits: { ...limits, concurrency: "3", rate: { ...limits.rate, burst: 1 } } };
    const page = pageOf([future]);
    expect(validatePersonalApplicationsPage(page).ok).toBe(false);
    expect(validatePersonalApplicationsPage(page, { mode: "tolerant" })).toMatchObject({
      ok: true,
      value: { applications: [{ limits }] }
    });
    const badRate = { ...item, limits: { ...limits, rate: { ...limits.rate, standard: { credits: "1", period_minutes: 1.5 } } } };
    expect(validatePersonalApplicationsPage(pageOf([badRate])).ok).toBe(false);
    const noRate = { ...item, limits: { standard_per_call: "1", premium_per_call: "1" } };
    expect(validatePersonalApplicationsPage(pageOf([noRate])).ok).toBe(false);
  });

  it("requires range and each item's totals, with integer counts and canonical unit strings", () => {
    expect(validatePersonalApplicationsPage(pageOf([item]))).toMatchObject({
      ok: true,
      value: { range, applications: [{ totals }] }
    });
    const { range: _range, ...noRange } = pageOf([item]);
    expect(validatePersonalApplicationsPage(noRange).ok).toBe(false);
    expect(validatePersonalApplicationsPage(pageOf([summary])).ok).toBe(false);
    expect(validatePersonalApplicationsPage(pageOf([{ ...item, totals: { ...totals, standard_requests: 1.5 } }])).ok).toBe(false);
    expect(validatePersonalApplicationsPage(pageOf([{ ...item, totals: { ...totals, premium_units_used: "01" } }])).ok).toBe(false);
    const { premium_units_used: _omitted, ...partial } = totals;
    expect(validatePersonalApplicationsPage(pageOf([{ ...item, totals: partial }])).ok).toBe(false);
    expect(validatePersonalApplicationsPage({ ...pageOf([item]), range: { ...range, timezone: "PST" } }).ok).toBe(false);
  });

  it("rejects a renamed id field on a list entry", () => {
    const renamed = { ...item, application_id: item.id } as Record<string, unknown>;
    delete renamed.id;
    const result = validatePersonalApplicationsPage(pageOf([renamed]));
    expect(result.ok).toBe(false);
  });

  it("accepts the full detail body including usage and cost profile", () => {
    const detail = {
      ...summary,
      usage: {
        range: { from: "2026-01-01T00:00:00Z", to: "2026-01-31T00:00:00Z", timezone: "UTC" },
        data_fresh_at: "2026-01-31T01:00:00Z",
        daily: [
          {
            day: "2026-01-15",
            standard_requests: 3,
            premium_requests: 1,
            standard_units_used: "10",
            premium_units_used: "5"
          }
        ]
      },
      cost_profile: {
        disclosed: true,
        premium_enabled: true,
        uses_premium: true,
        median_premium_units_per_charged_call: "5",
        p90_premium_units_per_charged_call: "9",
        max_premium_units_per_charged_call: "20",
        premium_units_histogram: { upper_units: "10000", bin_shares_permille: [1000, ...Array<number>(49).fill(0)], above_share_permille: 0 },
        window_start: "2026-01-01T00:00:00Z",
        window_end: "2026-01-31T00:00:00Z",
        computed_at: "2026-01-31T01:00:00Z"
      }
    };
    const result = validatePersonalApplicationDetail(detail);
    expect(result.ok).toBe(true);
  });

  it("rejects a cost profile carrying figures while undisclosed", () => {
    const result = validatePersonalApplicationDetail({
      ...summary,
      usage: {
        range: { from: "2026-01-01T00:00:00Z", to: "2026-01-31T00:00:00Z", timezone: "UTC" },
        data_fresh_at: "2026-01-31T01:00:00Z",
        daily: []
      },
      cost_profile: {
        disclosed: false,
        premium_enabled: true,
        uses_premium: true,
        median_premium_units_per_charged_call: "5",
        window_start: "2026-01-01T00:00:00Z",
        window_end: "2026-01-31T00:00:00Z",
        computed_at: "2026-01-31T01:00:00Z"
      }
    });
    expect(result.ok).toBe(false);
  });
});

describe("validatePatchPersonalApplicationLimitRequest", () => {
  it("accepts a nonnegative limit, including zero", () => {
    expect(validatePatchPersonalApplicationLimitRequest({ limits: { premium_per_call: "0" } })).toEqual({
      ok: true,
      value: { limits: { premium_per_call: "0" } }
    });
  });

  it("accepts either per-call key alone or both, and refuses an empty limits object", () => {
    expect(validatePatchPersonalApplicationLimitRequest({ limits: { standard_per_call: "5" } })).toEqual({
      ok: true,
      value: { limits: { standard_per_call: "5" } }
    });
    expect(validatePatchPersonalApplicationLimitRequest({ limits: { standard_per_call: "5", premium_per_call: "0" } })).toEqual({
      ok: true,
      value: { limits: { standard_per_call: "5", premium_per_call: "0" } }
    });
    expect(validatePatchPersonalApplicationLimitRequest({ limits: {} }).ok).toBe(false);
  });

  it("rejects an unknown field, an unknown nested key (including rate), and the legacy flat body", () => {
    expect(validatePatchPersonalApplicationLimitRequest({ limits: { premium_per_call: "10" }, note: "x" }).ok).toBe(false);
    expect(validatePatchPersonalApplicationLimitRequest({ limits: { premium_per_call: "10", rate: {} } }).ok).toBe(false);
    expect(validatePatchPersonalApplicationLimitRequest({ premium_per_call_limit: "10" }).ok).toBe(false);
  });

  it("rejects a non-canonical amount", () => {
    expect(validatePatchPersonalApplicationLimitRequest({ limits: { premium_per_call: "01" } }).ok).toBe(false);
    expect(validatePatchPersonalApplicationLimitRequest({ limits: { premium_per_call: 5 } }).ok).toBe(false);
  });
});

describe("validateConsentCompletionRequest", () => {
  it("accepts exactly { limits: { premium_per_call } } and refuses anything else", () => {
    expect(validateConsentCompletionRequest({ limits: { premium_per_call: "7" } }).ok).toBe(true);
    expect(validateConsentCompletionRequest({ limits: { premium_per_call: "7" }, token: "t" }).ok).toBe(false);
    expect(validateConsentCompletionRequest({ premium_per_call_limit: "7" }).ok).toBe(false);
  });

  it("accepts an optional canonical standard_per_call and still refuses rate", () => {
    const both = validateConsentCompletionRequest({
      limits: { premium_per_call: "7", standard_per_call: "3" }
    });
    expect(both.ok && both.value).toEqual({ limits: { premium_per_call: "7", standard_per_call: "3" } });
    expect(validateConsentCompletionRequest({ limits: { standard_per_call: "3" } }).ok).toBe(false);
    expect(validateConsentCompletionRequest({ limits: { premium_per_call: "7", standard_per_call: "03" } }).ok).toBe(false);
    expect(validateConsentCompletionRequest({ limits: { premium_per_call: "7", standard_per_call: 3 } }).ok).toBe(false);
    expect(validateConsentCompletionRequest({ limits: { premium_per_call: "7", rate: {} } }).ok).toBe(false);
  });
});

describe("validateStartContactVerificationRequest", () => {
  it("accepts the documented shape", () => {
    expect(
      validateStartContactVerificationRequest({ contact_type: "email", value: "a@example.com" }).ok
    ).toBe(true);
  });

  it("rejects an unsupported contact_type value", () => {
    expect(validateStartContactVerificationRequest({ contact_type: "fax", value: "555" }).ok).toBe(
      false
    );
  });
});

describe("validateConsentInfo", () => {
  const base = {
    application: {
      id: "app_1",
      name: "App",
      business_display_name: "Biz",
      environment: "live"
    },
    cost_profile: {
      disclosed: true,
      premium_enabled: true,
      uses_premium: true,
      median_premium_units_per_charged_call: "5",
      p90_premium_units_per_charged_call: "9",
      max_premium_units_per_charged_call: "20",
      premium_units_histogram: { upper_units: "10000", bin_shares_permille: [1000, ...Array<number>(49).fill(0)], above_share_permille: 0 },
      window_start: "2026-01-01T00:00:00Z",
      window_end: "2026-01-31T00:00:00Z",
      computed_at: "2026-01-31T01:00:00Z"
    },
    prefill_limits: { standard_per_call: "10000", premium_per_call: "1000", rate: { standard: { credits: "500", period_minutes: 60 }, premium: { credits: "200", period_minutes: 1440 } } },
    is_reauthorization: false,
    standard_unmetered: false
  };

  it("accepts the documented shape", () => {
    expect(validateConsentInfo(base).ok).toBe(true);
  });

  it("requires standard_unmetered as a boolean", () => {
    expect(validateConsentInfo({ ...base, standard_unmetered: true })).toMatchObject({
      ok: true,
      value: { standard_unmetered: true }
    });
    const { standard_unmetered: _u, ...missing } = base;
    expect(validateConsentInfo(missing).ok).toBe(false);
    expect(validateConsentInfo({ ...base, standard_unmetered: "true" }).ok).toBe(false);
  });

  it("carries existing_limits when present and rejects the legacy flat fields as a replacement", () => {
    const existing = { standard_per_call: "9", premium_per_call: "5", rate: { standard: { credits: "1", period_minutes: 30 }, premium: { credits: "2", period_minutes: 30 } } };
    expect(validateConsentInfo({ ...base, existing_limits: existing, is_reauthorization: true })).toMatchObject({
      ok: true,
      value: { existing_limits: existing }
    });
    const { prefill_limits: _p, ...rest } = base;
    expect(validateConsentInfo({ ...rest, prefill_premium_per_call_limit: "1000" }).ok).toBe(false);
  });

  it("requires all three charged-call figures when disclosed and none when withheld", () => {
    const profile = base.cost_profile;
    const { p90_premium_units_per_charged_call: _p90, ...partial } = profile;
    expect(validateConsentInfo({ ...base, cost_profile: partial }).ok).toBe(false);
    expect(validateConsentInfo({ ...base, cost_profile: { ...profile, disclosed: false } }).ok).toBe(false);
    const withheld = { disclosed: false, premium_enabled: true, uses_premium: true, window_start: profile.window_start, window_end: profile.window_end, computed_at: profile.computed_at };
    expect(validateConsentInfo({ ...base, cost_profile: withheld }).ok).toBe(true);
  });

  it("requires premium_enabled on the cost profile, independent of disclosure (owner decision 2026-10-25)", () => {
    const { premium_enabled: _enabled, ...missing } = base.cost_profile;
    expect(validateConsentInfo({ ...base, cost_profile: missing }).ok).toBe(false);
    const off = { ...base.cost_profile, premium_enabled: false };
    expect(validateConsentInfo({ ...base, cost_profile: off })).toMatchObject({
      ok: true,
      value: { cost_profile: { premium_enabled: false, disclosed: true } }
    });
  });

  it("rejects a renamed business_display_name field", () => {
    const application = {
      ...base.application,
      display_name: base.application.business_display_name
    } as Record<string, unknown>;
    delete application.business_display_name;
    expect(validateConsentInfo({ ...base, application }).ok).toBe(false);
  });
});

describe("validateSubscriptionPlanCatalog", () => {
  it("accepts a catalog with exactly one free plan", () => {
    const entry = {
      id: "plan_free",
      display_name: "Free",
      included_premium_credit_units: "0",
      included_standard_credit_units: null,
      price_minor_units: "0",
      currency: "USD",
      interval: "month",
      is_free: true,
      limits: { requests_per_minute: 60, default_max_output_tokens: 4096 },
      catalog_version: "2026-01-01"
    };
    expect(
      validateSubscriptionPlanCatalog({
        catalog_version: "2026-01-01",
        plans: [entry],
        bundles: [
          {
            id: "premium-10000",
            display_name: "10,000 premium credits",
            premium_credit_units: "10000000",
            standard_credit_units: "0",
            price_minor_units: "1000",
            currency: "USD",
            catalog_version: "2026-01-01"
          }
        ]
      }).ok
    ).toBe(true);
  });

  it("rejects a bare array (the wrapper is required)", () => {
    const entry = {
      id: "plan_free",
      display_name: "Free",
      included_premium_credit_units: "0",
      included_standard_credit_units: null,
      price_minor_units: "0",
      currency: "USD",
      interval: "month",
      is_free: true,
      limits: { requests_per_minute: 60, default_max_output_tokens: 4096 },
      catalog_version: "2026-01-01"
    };
    expect(validateSubscriptionPlanCatalog([entry]).ok).toBe(false);
  });

  it("rejects a catalog with zero or more than one free plan", () => {
    const paid = {
      id: "plan_paid",
      display_name: "Paid",
      included_premium_credit_units: "1000",
      included_standard_credit_units: "1000",
      price_minor_units: "1999",
      currency: "USD",
      interval: "month",
      is_free: false,
      limits: { requests_per_minute: 600, default_max_output_tokens: 4096 },
      catalog_version: "2026-01-01"
    };
    expect(
      validateSubscriptionPlanCatalog({
        catalog_version: "2026-01-01",
        plans: [paid],
        bundles: []
      }).ok
    ).toBe(false);
  });
});

describe("validateSubscriptionSelectionRequest / validateCreditsCheckoutRequest / validateDashboardCheckoutResponse", () => {
  it("accepts the documented subscription selection body", () => {
    expect(
      validateSubscriptionSelectionRequest({ plan_id: "plan_pro", catalog_version: "2026-01-01" })
        .ok
    ).toBe(true);
  });

  it("accepts only a versioned fixed credit bundle selection", () => {
    expect(
      validateCreditsCheckoutRequest({
        bundle_id: "premium-10000",
        catalog_version: "2026-01-01"
      }).ok
    ).toBe(true);
    expect(validateCreditsCheckoutRequest({ premium_credit_units: "10000" }).ok).toBe(false);
  });

  it("accepts the shared checkout response shape", () => {
    expect(
      validateDashboardCheckoutResponse({
        transaction_id: "txn_1",
        redirect_url: "https://pay.example.com/x"
      }).ok
    ).toBe(true);
  });

  it("requires the created order ID on a bundle checkout response", () => {
    const body = { transaction_id: "txn_1", redirect_url: "https://pay.example.com/x" };
    expect(validateCreditsCheckoutResponse({ ...body, order_id: "order_1" })).toEqual({
      ok: true,
      value: { ...body, order_id: "order_1" }
    });
    expect(validateCreditsCheckoutResponse(body).ok).toBe(false);
  });
});

describe("purchase order refund contracts", () => {
  const order = {
    id: "order_1",
    kind: "bundle",
    product_id: "premium-10000",
    product_catalog_version: "2026-01-01",
    product_display_name: "10,000 premium credits",
    status: "active",
    paid_minor_units: "1000",
    currency: "USD",
    purchased_at: "2026-01-01T00:00:00Z",
    refundable_until: "2026-01-15T00:00:00Z",
    refund: {
      eligibility: "half",
      refund_minor_units: "500",
      currency: "USD",
      reason: "within_usage_threshold"
    }
  };

  it("accepts an order and its exact refund quote", () => {
    expect(validateDashboardPurchaseOrderSummary(order).ok).toBe(true);
    expect(validateDashboardPurchaseOrderPage({ orders: [order], next_cursor: null }).ok).toBe(
      true
    );
  });

  it("rejects non-canonical money and unknown refund reasons", () => {
    expect(validateDashboardPurchaseOrderSummary({ ...order, paid_minor_units: "01000" }).ok).toBe(
      false
    );
    expect(
      validateDashboardPurchaseOrderSummary({
        ...order,
        refund: { ...order.refund, reason: "approximately_unused" }
      }).ok
    ).toBe(false);
  });
});

const API_KEY_MODEL = {
  id: "key_1",
  name: "prod",
  prefix: "sk_live_ab",
  scope: "model",
  application_id: "app_1",
  environment: "live",
  status: "active",
  created_at: "2026-01-01T00:00:00Z",
  expires_at: null,
  last_used_at: null
};

const API_KEY_REPORTING = {
  id: "key_2",
  name: "reporting",
  prefix: "sk_rep_cd",
  scope: "reporting",
  application_id: null,
  environment: null,
  status: "active",
  created_at: "2026-01-01T00:00:00Z",
  expires_at: null,
  last_used_at: null
};

describe("validateApiKeyMetadata", () => {
  it("accepts a model-scope key with non-null application_id/environment", () => {
    expect(validateApiKeyMetadata(API_KEY_MODEL).ok).toBe(true);
  });

  it("accepts a reporting-scope key with null application_id/environment", () => {
    expect(validateApiKeyMetadata(API_KEY_REPORTING).ok).toBe(true);
  });

  it("rejects a model-scope key with a null application_id", () => {
    expect(validateApiKeyMetadata({ ...API_KEY_MODEL, application_id: null }).ok).toBe(false);
  });

  it("rejects a reporting-scope key with a non-null application_id", () => {
    expect(validateApiKeyMetadata({ ...API_KEY_REPORTING, application_id: "app_1" }).ok).toBe(
      false
    );
  });

  it("rejects an unrecognized status rather than passing it through", () => {
    expect(validateApiKeyMetadata({ ...API_KEY_MODEL, status: "pending" }).ok).toBe(false);
  });

  it("rejects a body carrying a raw secret", () => {
    expect(validateApiKeyMetadata({ ...API_KEY_MODEL, secret: "sk_live_raw" }).ok).toBe(false);
  });
});

describe("validateApiKeyMetadataList / validateCreateBusinessKeyResponse", () => {
  it("accepts a bare array (the delete/list response shape)", () => {
    const result = validateApiKeyMetadataList([API_KEY_MODEL, API_KEY_REPORTING]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(2);
  });

  it("rejects a wrapped object in place of the bare array", () => {
    expect(validateApiKeyMetadataList({ keys: [API_KEY_MODEL] }).ok).toBe(false);
  });

  it("accepts the create/rotate response's metadata+secret shape", () => {
    expect(
      validateCreateBusinessKeyResponse({ metadata: API_KEY_MODEL, secret: "sk_live_raw" }).ok
    ).toBe(true);
  });
});

describe("validateCreateBusinessKeyRequest", () => {
  it("requires application_id for scope model", () => {
    expect(validateCreateBusinessKeyRequest({ scope: "model", name: "k" }).ok).toBe(false);
    expect(
      validateCreateBusinessKeyRequest({ scope: "model", name: "k", application_id: "app_1" }).ok
    ).toBe(true);
  });

  it("forbids application_id for scope reporting", () => {
    expect(
      validateCreateBusinessKeyRequest({ scope: "reporting", name: "k", application_id: "app_1" })
        .ok
    ).toBe(false);
    expect(validateCreateBusinessKeyRequest({ scope: "reporting", name: "k" }).ok).toBe(true);
  });
});

function businessApplicationSummary(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "app_1",
    name: "App",
    environment: "live",
    status: "active",
    client_id: "client_1",
    created_at: "2026-01-01T00:00:00.000Z",
    api_keys: [API_KEY_MODEL],
    daily_visitors: [{ date: "2026-01-01", count: 5 }],
    visitors: 5,
    usage: {
      standard: { requests: 10, used_nano_usd: "100" },
      premium: { requests: 2, used_nano_usd: "20", earnings_nano_usd: "500000" }
    },
    ...overrides
  };
}

function businessDashboardInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    business: { id: "biz_1", name: "Acme" },
    earnings: {
      earnings_nano_usd: "1000000000",
      payout_pending_nano_usd: "0",
      display_currency: "USD"
    },
    payout: {
      eligible: true,
      connected_account_status: "enabled",
      policy_code_version: "2026-01-01",
      minimum_available_nano_usd: "50000000000",
      next_eligible_at: null
    },
    traffic: {
      daily_visitors: [{ date: "2026-01-02", count: 3 }],
      daily_usage: [
        {
          date: "2026-01-02",
          standard_requests: 4,
          premium_requests: 1,
          premium_earnings_nano_usd: "1000"
        }
      ],
      usage: {
        standard: { requests: 4, used_nano_usd: "40" },
        premium: { requests: 1, used_nano_usd: "5", earnings_nano_usd: "1000" }
      }
    },
    applications: [businessApplicationSummary()],
    next_cursor: null,
    range: { from: "2026-01-01T00:00:00Z", to: "2026-01-31T00:00:00Z", timezone: "UTC" },
    data_fresh_at: "2026-01-31T01:00:00Z",
    ...overrides
  };
}

describe("validateBusinessDashboardInfo", () => {
  it("accepts the documented shape (shared by GET /v1/dashboard/business and GET /v1/business/info)", () => {
    expect(validateBusinessDashboardInfo(businessDashboardInfo()).ok).toBe(true);
  });

  it("uses NANOUSD-only aggregate usage and refuses legacy credit-unit fields", () => {
    const legacy = businessDashboardInfo();
    const usage = (legacy.traffic as Record<string, unknown>).usage as Record<string, unknown>;
    const standard = usage.standard as Record<string, unknown>;
    standard.credit_units_used = standard.used_nano_usd;
    delete standard.used_nano_usd;
    expect(validateBusinessDashboardInfo(legacy)).toMatchObject({
      ok: false,
      error: { param: "traffic.usage.standard.used_nano_usd" }
    });
  });

  it("parses the shared business-info future-enum fixture tolerantly", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../fixtures/responses/business-info--future-enum.json", import.meta.url), "utf8")
    ) as { readonly body: unknown; readonly expected_tolerant: unknown };
    expect(validateBusinessDashboardInfo(fixture.body).ok).toBe(false);
    expect(validateBusinessDashboardInfo(fixture.body, { mode: "tolerant" })).toMatchObject({
      ok: true,
      value: fixture.expected_tolerant
    });
  });

  it("requires the business-wide traffic block and validates its usage buckets", () => {
    const missing = businessDashboardInfo();
    delete missing.traffic;
    expect(validateBusinessDashboardInfo(missing).ok).toBe(false);
    expect(
      validateBusinessDashboardInfo(
        businessDashboardInfo({
          traffic: {
            daily_visitors: [],
            daily_usage: [],
            usage: {
              standard: { requests: 0, used_nano_usd: "0" },
              premium: { requests: 0, used_nano_usd: "0" }
            }
          }
        })
      ).ok
    ).toBe(false);
  });

  it("validates traffic.daily_usage rows: exact fields, canonical earnings, required, strict", () => {
    const withUsage = (daily_usage: unknown) => {
      const info = businessDashboardInfo();
      return { ...info, traffic: { ...(info.traffic as object), daily_usage } };
    };
    const row = {
      date: "2026-01-02",
      standard_requests: 4,
      premium_requests: 1,
      premium_earnings_nano_usd: "1000"
    };
    expect(validateBusinessDashboardInfo(withUsage([row])).ok).toBe(true);
    const missing = withUsage([row]) as { traffic: Record<string, unknown> };
    delete missing.traffic.daily_usage;
    expect(validateBusinessDashboardInfo(missing)).toMatchObject({
      ok: false,
      error: { param: "traffic.daily_usage" }
    });
    expect(
      validateBusinessDashboardInfo(withUsage([{ ...row, premium_earnings_nano_usd: "01" }])).ok
    ).toBe(false);
    expect(validateBusinessDashboardInfo(withUsage([{ ...row, extra: 1 }])).ok).toBe(false);
  });

  it("rejects a renamed application field (application_id instead of id)", () => {
    const app = businessApplicationSummary() as Record<string, unknown>;
    app.application_id = app.id;
    delete app.id;
    expect(validateBusinessDashboardInfo(businessDashboardInfo({ applications: [app] })).ok).toBe(
      false
    );
  });

  it("rejects a renamed usage bucket field (request_count instead of requests)", () => {
    const app = businessApplicationSummary() as Record<string, unknown> & {
      usage: { standard: Record<string, unknown> };
    };
    app.usage.standard.request_count = app.usage.standard.requests;
    delete app.usage.standard.requests;
    expect(validateBusinessDashboardInfo(businessDashboardInfo({ applications: [app] })).ok).toBe(
      false
    );
  });

  it("requires blocked_reason present iff not eligible", () => {
    const blocked = businessDashboardInfo({
      payout: {
        eligible: false,
        connected_account_status: "restricted",
        policy_code_version: "2026-01-01",
        minimum_available_nano_usd: "50000000000",
        next_eligible_at: "2026-02-01T00:00:00Z",
        blocked_reason: "below_minimum"
      }
    });
    expect(validateBusinessDashboardInfo(blocked).ok).toBe(true);

    const missingReason = businessDashboardInfo({
      payout: {
        eligible: false,
        connected_account_status: "restricted",
        policy_code_version: "2026-01-01",
        minimum_available_nano_usd: "50000000000",
        next_eligible_at: "2026-02-01T00:00:00Z"
      }
    });
    expect(validateBusinessDashboardInfo(missingReason).ok).toBe(false);

    const spuriousReason = businessDashboardInfo({
      payout: {
        eligible: true,
        connected_account_status: "enabled",
        policy_code_version: "2026-01-01",
        minimum_available_nano_usd: "50000000000",
        next_eligible_at: null,
        blocked_reason: "below_minimum"
      }
    });
    expect(validateBusinessDashboardInfo(spuriousReason).ok).toBe(false);
  });

  it("rejects an unrecognized connected_account_status rather than passing it through", () => {
    const body = businessDashboardInfo({
      payout: {
        eligible: true,
        connected_account_status: "verified",
        policy_code_version: "2026-01-01",
        minimum_available_nano_usd: "50000000000",
        next_eligible_at: null
      }
    });
    expect(validateBusinessDashboardInfo(body).ok).toBe(false);
  });

  it("always requires minimum_available_nano_usd and next_eligible_at present", () => {
    const payout = businessDashboardInfo().payout as Record<string, unknown>;
    delete payout.minimum_available_nano_usd;
    expect(validateBusinessDashboardInfo(businessDashboardInfo({ payout })).ok).toBe(false);
  });
});

describe("validateCreateBusinessApplicationRequest / validateUpdateBusinessApplicationRequest", () => {
  it("accepts the documented create body", () => {
    const result = validateCreateBusinessApplicationRequest({
      name: "App",
      environment: "test",
      redirect_uris: ["https://app.example.com/callback"],
      allowed_origins: ["https://app.example.com"]
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown field on create", () => {
    expect(
      validateCreateBusinessApplicationRequest({
        name: "App",
        environment: "test",
        redirect_uris: [],
        allowed_origins: [],
        extra: 1
      }).ok
    ).toBe(false);
  });

  it("rejects a redirect_uri carrying a fragment or userinfo, and a non-https non-loopback origin", () => {
    expect(
      validateCreateBusinessApplicationRequest({
        name: "App",
        environment: "test",
        redirect_uris: ["https://app.example.com/callback#frag"],
        allowed_origins: []
      }).ok
    ).toBe(false);
    expect(
      validateCreateBusinessApplicationRequest({
        name: "App",
        environment: "test",
        redirect_uris: ["https://user:pass@app.example.com/callback"],
        allowed_origins: []
      }).ok
    ).toBe(false);
    expect(
      validateCreateBusinessApplicationRequest({
        name: "App",
        environment: "test",
        redirect_uris: [],
        allowed_origins: ["http://app.example.com"]
      }).ok
    ).toBe(false);
  });

  it("allows http on a loopback host", () => {
    expect(
      validateCreateBusinessApplicationRequest({
        name: "App",
        environment: "test",
        redirect_uris: ["http://localhost:3000/callback"],
        allowed_origins: ["http://localhost:3000"]
      }).ok
    ).toBe(true);
  });

  it("rejects duplicate entries in redirect_uris", () => {
    expect(
      validateCreateBusinessApplicationRequest({
        name: "App",
        environment: "test",
        redirect_uris: ["https://app.example.com/callback", "https://app.example.com/callback"],
        allowed_origins: []
      }).ok
    ).toBe(false);
  });

  it("allows icon_url/description to be omitted, but not null, on create", () => {
    expect(
      validateCreateBusinessApplicationRequest({
        name: "App",
        environment: "test",
        redirect_uris: [],
        allowed_origins: [],
        icon_url: null
      }).ok
    ).toBe(false);
  });

  it("PATCH allows icon_url/description to be null (clear) or absent (unchanged), but rejects environment", () => {
    expect(validateUpdateBusinessApplicationRequest({ icon_url: null }).ok).toBe(true);
    expect(validateUpdateBusinessApplicationRequest({}).ok).toBe(true);
    expect(validateUpdateBusinessApplicationRequest({ environment: "live" }).ok).toBe(false);
  });

  it("accepts estimated_avg_charge_nano_usd as a positive canonical string (PATCH also null)", () => {
    expect(validateUpdateBusinessApplicationRequest({ estimated_avg_charge_nano_usd: "5000" }).ok).toBe(true);
    expect(validateUpdateBusinessApplicationRequest({ estimated_avg_charge_nano_usd: null }).ok).toBe(true);
    for (const bad of ["0", "-1", "05", 5, "1.5"]) {
      expect(validateUpdateBusinessApplicationRequest({ estimated_avg_charge_nano_usd: bad }).ok).toBe(false);
    }
    const create = {
      name: "A",
      environment: "test",
      redirect_uris: [],
      allowed_origins: [],
      estimated_avg_charge_nano_usd: "5000"
    };
    expect(validateCreateBusinessApplicationRequest(create).ok).toBe(true);
    expect(validateCreateBusinessApplicationRequest({ ...create, estimated_avg_charge_nano_usd: null }).ok).toBe(false);
  });
});

describe("business summary, info, cost profile, and payout list additions", () => {
  it("summary requires created_at and carries an optional icon_url", () => {
    const { created_at: _c, ...missing } = businessApplicationSummary();
    expect(validateBusinessDashboardInfo(businessDashboardInfo({ applications: [missing] })).ok).toBe(false);
    const withIcon = businessApplicationSummary({ icon_url: "https://x/i.png" });
    expect(validateBusinessDashboardInfo(businessDashboardInfo({ applications: [withIcon] })).ok).toBe(true);
  });

  it("summary requires visitors as a non-negative integer", () => {
    const { visitors: _v, ...missing } = businessApplicationSummary();
    const check = (app: unknown) =>
      validateBusinessDashboardInfo(businessDashboardInfo({ applications: [app] })).ok;
    expect(check(missing)).toBe(false);
    expect(check(businessApplicationSummary({ visitors: -1 }))).toBe(false);
    expect(check(businessApplicationSummary({ visitors: 1.5 }))).toBe(false);
    expect(check(businessApplicationSummary({ visitors: "3" }))).toBe(false);
    expect(check(businessApplicationSummary({ visitors: 0 }))).toBe(true);
  });

  it("order purchased_at is required and nullable", () => {
    const base = {
      id: "o", kind: "bundle", product_id: "p", product_catalog_version: "v",
      product_display_name: "P", status: "active", paid_minor_units: "1", currency: "USD",
      refundable_until: "2026-01-15T00:00:00Z",
      refund: { eligibility: "half", refund_minor_units: "1", currency: "USD", reason: "within_usage_threshold" }
    };
    expect(validateDashboardPurchaseOrderSummary(base).ok).toBe(false);
    expect(validateDashboardPurchaseOrderSummary({ ...base, purchased_at: null }).ok).toBe(true);
    expect(validateDashboardPurchaseOrderSummary({ ...base, purchased_at: "bad" }).ok).toBe(false);
  });

  it("info accepts estimated_avg_charge_nano_usd", () => {
    const result = validateBusinessApplicationInfo({ estimated_avg_charge_nano_usd: "5000" });
    expect(result).toEqual({ ok: true, value: { estimated_avg_charge_nano_usd: "5000" } });
  });

  it("cost profile estimate is allowed only while undisclosed", () => {
    const withheld = {
      disclosed: false,
      premium_enabled: true,
      uses_premium: true,
      estimated_premium_units_per_charged_call: "7",
      window_start: "2026-01-01T00:00:00.000Z",
      window_end: "2026-02-01T00:00:00.000Z",
      computed_at: "2026-02-01T00:00:00.000Z"
    };
    expect(validateApplicationCostProfile(withheld).ok).toBe(true);
    const disclosed = {
      ...withheld,
      disclosed: true,
      median_premium_units_per_charged_call: "1",
      p90_premium_units_per_charged_call: "2",
      max_premium_units_per_charged_call: "3",
      premium_units_histogram: { upper_units: "10000", bin_shares_permille: [1000, ...Array<number>(49).fill(0)], above_share_permille: 0 },
    };
    expect(validateApplicationCostProfile(disclosed).ok).toBe(false);
  });

  it("cost profile histogram: present exactly when disclosed, 50 bins on a 1-2-5 span summing to 1000", () => {
    const disclosed = {
      disclosed: true,
      premium_enabled: true,
      uses_premium: true,
      median_premium_units_per_charged_call: "1",
      p90_premium_units_per_charged_call: "2",
      max_premium_units_per_charged_call: "3",
      window_start: "2026-01-01T00:00:00.000Z",
      window_end: "2026-02-01T00:00:00.000Z",
      computed_at: "2026-02-01T00:00:00.000Z"
    };
    const bins = (first: number) => [first, ...Array<number>(49).fill(0)];
    const withHistogram = (histogram: unknown) => ({ ...disclosed, premium_units_histogram: histogram });
    const good = { upper_units: "20000", bin_shares_permille: bins(990), above_share_permille: 10 };
    expect(validateApplicationCostProfile(withHistogram(good))).toMatchObject({
      ok: true,
      value: { premium_units_histogram: good }
    });
    // Missing while disclosed, or present while withheld.
    expect(validateApplicationCostProfile(disclosed).ok).toBe(false);
    const withheld = {
      disclosed: false,
      premium_enabled: true,
      uses_premium: true,
      window_start: disclosed.window_start,
      window_end: disclosed.window_end,
      computed_at: disclosed.computed_at
    };
    expect(validateApplicationCostProfile({ ...withheld, premium_units_histogram: good }).ok).toBe(false);
    // Not a 1-2-5 span of at least 10 credits.
    for (const upper_units of ["5000", "30000", "0", "10001"]) {
      expect(validateApplicationCostProfile(withHistogram({ ...good, upper_units })).ok).toBe(false);
    }
    // The bin count follows the span: 50 up to 50 credits, one per credit to
    // 1,000 credits, then 1,000. Any other length is refused.
    const sized = (count: number) => [1000, ...Array<number>(count - 1).fill(0)];
    for (const [upper_units, count] of [["10000", 50], ["50000", 50], ["100000", 100], ["1000000", 1000], ["5000000", 1000]] as const) {
      expect(premiumUnitsHistogramBinCount(BigInt(upper_units))).toBe(count);
      const histogram = { upper_units, bin_shares_permille: sized(count), above_share_permille: 0 };
      expect(validateApplicationCostProfile(withHistogram(histogram)).ok).toBe(true);
      const wrong = { ...histogram, bin_shares_permille: sized(count === 50 ? 100 : 50) };
      expect(validateApplicationCostProfile(withHistogram(wrong)).ok).toBe(false);
    }
    // Wrong bin count, a sum other than 1000, or a non-integer share.
    expect(validateApplicationCostProfile(withHistogram({ ...good, bin_shares_permille: [1000] })).ok).toBe(false);
    expect(validateApplicationCostProfile(withHistogram({ ...good, above_share_permille: 9 })).ok).toBe(false);
    const fractional = [989.5, 0.5, ...Array<number>(48).fill(0)];
    expect(validateApplicationCostProfile(withHistogram({ ...good, bin_shares_permille: fractional })).ok).toBe(false);
  });

  it("payout list: settled_at is null exactly while pending, and unknown fields are refused", () => {
    const record = {
      id: "p1",
      amount_nano_usd: "50000000000",
      status: "completed",
      requested_at: "2026-03-01T00:00:00.000Z",
      settled_at: "2026-03-02T00:00:00.000Z"
    };
    expect(validateBusinessPayoutList({ payouts: [record], next_cursor: null }).ok).toBe(true);
    expect(validateBusinessPayoutList({ payouts: [{ ...record, settled_at: null }], next_cursor: null }).ok).toBe(false);
    expect(
      validateBusinessPayoutList({ payouts: [{ ...record, status: "pending" }], next_cursor: "c" }).ok
    ).toBe(false);
    expect(
      validateBusinessPayoutList({ payouts: [{ ...record, provider_id: "x" }], next_cursor: null }).ok
    ).toBe(false);
  });
});

describe("validateBusinessApplicationDetail", () => {
  function makeDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "app_1",
      client_id: "client_1",
      name: "App",
      environment: "live",
      status: "active",
      premium_enabled: false,
      info: null,
      redirect_uris: ["https://app.example.com/callback"],
      allowed_origins: ["https://app.example.com"],
      created_at: "2026-01-01T00:00:00Z",
      analytics: {
        range: { from: "2026-01-01T00:00:00Z", to: "2026-01-31T00:00:00Z", timezone: "UTC" },
        days: [
          {
            day: "2026-01-15",
            daily_visitors: 5,
            standard_requests: 10,
            premium_requests: 2,
            standard_used_nano_usd: "100",
            premium_used_nano_usd: "20",
            business_earnings_nano_usd: "500000"
          }
        ],
        next_cursor: null
      },
      api_keys: [API_KEY_MODEL],
      ...overrides
    };
  }

  it("accepts the documented shape, including redirect_uris/allowed_origins and a null info", () => {
    expect(validateBusinessApplicationDetail(makeDetail()).ok).toBe(true);
  });

  it("carries NANOUSD used figures per day and no field name containing units", () => {
    const result = validateBusinessApplicationDetail(makeDetail());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.analytics.days[0]?.standard_used_nano_usd).toBe("100");
      expect(result.value.analytics.days[0]?.premium_used_nano_usd).toBe("20");
      expect(JSON.stringify(result.value)).not.toMatch(/units/i);
    }
  });

  it("rejects a day row that still carries credit-unit fields instead of NANOUSD ones", () => {
    const detail = makeDetail();
    (detail.analytics as { days: Record<string, unknown>[] }).days = [
      {
        day: "2026-01-15",
        daily_visitors: 5,
        standard_requests: 10,
        premium_requests: 2,
        standard_units_used: "100",
        premium_units_used: "20",
        business_earnings_nano_usd: "500000"
      }
    ];
    expect(validateBusinessApplicationDetail(detail).ok).toBe(false);
  });

  it("accepts info carrying icon_url/description by field name", () => {
    const result = validateBusinessApplicationDetail(
      makeDetail({ info: { icon_url: "https://example.com/icon.png", description: "A test app" } })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.info).toEqual({
        icon_url: "https://example.com/icon.png",
        description: "A test app"
      });
    }
  });

  it("rejects an info object carrying an unallowlisted key", () => {
    expect(
      validateBusinessApplicationDetail(
        makeDetail({ info: { icon_url: "https://x.example.com", extra: 1 } })
      ).ok
    ).toBe(false);
  });

  it("requires a boolean premium_enabled (owner decision 2026-10-25)", () => {
    const result = validateBusinessApplicationDetail(makeDetail({ premium_enabled: true }));
    expect(result.ok && result.value.premium_enabled).toBe(true);
    const detail = makeDetail();
    delete detail.premium_enabled;
    expect(validateBusinessApplicationDetail(detail).ok).toBe(false);
    expect(validateBusinessApplicationDetail(makeDetail({ premium_enabled: "true" })).ok).toBe(false);
  });

  it("rejects a detail missing redirect_uris", () => {
    const detail = makeDetail();
    delete detail.redirect_uris;
    expect(validateBusinessApplicationDetail(detail).ok).toBe(false);
  });

  it("rejects a detail missing allowed_origins", () => {
    const detail = makeDetail();
    delete detail.allowed_origins;
    expect(validateBusinessApplicationDetail(detail).ok).toBe(false);
  });

  it("rejects a non-array redirect_uris/allowed_origins", () => {
    expect(
      validateBusinessApplicationDetail(makeDetail({ redirect_uris: "https://x.example.com" })).ok
    ).toBe(false);
    expect(
      validateBusinessApplicationDetail(makeDetail({ allowed_origins: "https://x.example.com" })).ok
    ).toBe(false);
  });
});

describe("validateCreateBusinessPayoutRequest", () => {
  it("requires a strictly positive amount", () => {
    expect(validateCreateBusinessPayoutRequest({ amount_nano_usd: "0" }).ok).toBe(false);
    expect(validateCreateBusinessPayoutRequest({ amount_nano_usd: "1" }).ok).toBe(true);
  });
});

describe("validateEmptyRequestBody", () => {
  it("accepts an absent or empty body", () => {
    expect(validateEmptyRequestBody(undefined).ok).toBe(true);
    expect(validateEmptyRequestBody({}).ok).toBe(true);
  });

  it("rejects a body carrying any field", () => {
    expect(validateEmptyRequestBody({ foo: "bar" }).ok).toBe(false);
  });
});

describe("validatePersonalPeriodPage", () => {
  const plan = {
    id: "free",
    display_name: "Free",
    is_free: true,
    price_minor_units: "0",
    currency: "usd",
    interval: "month",
    catalog_version: "2026-09-01"
  };
  const period = {
    period_start: "2026-08-01T00:00:00Z",
    period_end: "2026-09-01T00:00:00Z",
    plan
  };

  it("accepts the documented shape, including an empty history", () => {
    expect(validatePersonalPeriodPage({ periods: [period], next_cursor: "c" }).ok).toBe(true);
    expect(validatePersonalPeriodPage({ periods: [], next_cursor: null }).ok).toBe(true);
  });

  it("rejects a missing cursor, a non-RFC3339 boundary, and a plan missing its catalog version", () => {
    expect(validatePersonalPeriodPage({ periods: [period] }).ok).toBe(false);
    expect(
      validatePersonalPeriodPage({
        periods: [{ ...period, period_start: "2026-08-01" }],
        next_cursor: null
      }).ok
    ).toBe(false);
    const { catalog_version: _dropped, ...planWithoutVersion } = plan;
    expect(
      validatePersonalPeriodPage({
        periods: [{ ...period, plan: planWithoutVersion }],
        next_cursor: null
      }).ok
    ).toBe(false);
  });
});

describe("validatePersonalApplicationCallPage / validatePersonalApplicationCallsQuery", () => {
  const call = {
    id: "call_1",
    credit_type: "standard",
    status: "completed",
    units_used: "1500",
    units_reserved: "0",
    created_at: "2026-10-17T15:42:00Z",
    terminal_at: "2026-10-17T15:42:02Z",
    streamed: true,
    model_id: "model_a",
    input_tokens: 10,
    output_tokens: 20,
    finish_reason: "stop",
    error_category: null
  };
  const premium = { ...call, id: "call_2", credit_type: "premium", model_id: null, input_tokens: null, output_tokens: null };
  const pageOf = (calls: unknown[]) => ({ calls, page: 1, page_count: 1, total: calls.length });

  it("accepts the documented wrapper, including premium calls with null model and tokens", () => {
    expect(validatePersonalApplicationCallPage({ calls: [call, premium], page: 2, page_count: 3, total: 22 }).ok).toBe(true);
    expect(validatePersonalApplicationCallPage(pageOf([])).ok).toBe(true);
  });

  it("verifies literal field names: an absent, extra, or renamed field fails", () => {
    const { units_used: _omitted, ...missing } = call;
    expect(validatePersonalApplicationCallPage(pageOf([missing])).ok).toBe(false);
    expect(validatePersonalApplicationCallPage(pageOf([{ ...call, cost_nano_usd: "1" }])).ok).toBe(false);
    expect(validatePersonalApplicationCallPage({ calls: [call] }).ok).toBe(false);
    expect(validatePersonalApplicationCallPage({ calls: [], page: 0, page_count: 1, total: 0 }).ok).toBe(false);
    expect(validatePersonalApplicationCallPage({ calls: [], page: 1, page_count: 0, total: 0 }).ok).toBe(false);
    expect(validatePersonalApplicationCallPage({ calls: [], page: 1, page_count: 1, total: -1 }).ok).toBe(false);
    expect(validatePersonalApplicationCallPage({ calls: [], page: 1, page_count: 1, next_cursor: null }).ok).toBe(false);
    expect(validatePersonalApplicationCallPage({ items: [call], page: 1, page_count: 1, total: 1 }).ok).toBe(false);
    expect(validatePersonalApplicationCallPage(pageOf([{ ...call, units_used: "1.5" }])).ok).toBe(false);
    expect(validatePersonalApplicationCallPage(pageOf([{ ...call, status: "weird" }])).ok).toBe(false);
  });

  it("drops an extra field in tolerant mode", () => {
    const result = validatePersonalApplicationCallPage(pageOf([{ ...call, provider: "x" }]), { mode: "tolerant" });
    expect(result.ok && "provider" in result.value.calls[0]!).toBe(false);
  });

  it("accepts only sort time and charge and limit 1-50 with defaults", () => {
    expect(validatePersonalApplicationCallsQuery({})).toMatchObject({
      ok: true,
      value: { sort: "time", page: 1, limit: 10 }
    });
    expect(validatePersonalApplicationCallsQuery({ sort: "charge", limit: "50", page: "7" })).toMatchObject({
      ok: true,
      value: { sort: "charge", page: 7, limit: 50 }
    });
    expect(validatePersonalApplicationCallsQuery({ sort: "name" }).ok).toBe(false);
    for (const limit of ["0", "51", "-1", "x", "1.5"]) {
      expect(validatePersonalApplicationCallsQuery({ limit }).ok).toBe(false);
    }
    for (const page of ["0", "-1", "x", "1.5", ""]) {
      expect(validatePersonalApplicationCallsQuery({ page }).ok).toBe(false);
    }
  });
});

describe("API_KEY_SCOPE_LABELS", () => {
  it("names every wire scope with the spec's display name and description", async () => {
    const { API_KEY_SCOPES, API_KEY_SCOPE_LABELS, UNKNOWN_API_KEY_SCOPE_LABEL } = await import("../src/index.js");
    expect(Object.keys(API_KEY_SCOPE_LABELS).sort()).toEqual([...API_KEY_SCOPES].sort());
    expect(API_KEY_SCOPE_LABELS.model.label).toBe("App key");
    expect(API_KEY_SCOPE_LABELS.reporting.label).toBe("Read-only key");
    expect(API_KEY_SCOPE_LABELS.model.description).toMatch(/one app/);
    expect(API_KEY_SCOPE_LABELS.reporting.description).toMatch(/Can't make AI calls/);
    expect(UNKNOWN_API_KEY_SCOPE_LABEL).toBe("Key");
  });
});

describe("validateBusinessApplicationPremiumRequest", () => {
  it("accepts exactly { enabled: boolean }", () => {
    expect(validateBusinessApplicationPremiumRequest({ enabled: true })).toEqual({
      ok: true,
      value: { enabled: true }
    });
    expect(validateBusinessApplicationPremiumRequest({ enabled: false })).toEqual({
      ok: true,
      value: { enabled: false }
    });
  });

  it("refuses a missing or non-boolean enabled and any other field as invalid_value", () => {
    for (const body of [{}, { enabled: "true" }, { enabled: 1 }, { enabled: true, extra: 1 }, null, []]) {
      const result = validateBusinessApplicationPremiumRequest(body);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_value");
    }
  });
});
