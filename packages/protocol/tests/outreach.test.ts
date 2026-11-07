import { describe, expect, it } from "vitest";

import {
  OUTREACH_TRACKING_ID_PATTERN,
  validateOutreachVisitList,
  validateOutreachVisitListQuery,
  validateOutreachVisitRequest
} from "../src/outreach.js";

const ID = "0123456789abcdef0123456789abcdef";
const KEY = "fedcba9876543210fedcba9876543210";
const REQUEST = { tracking_id: ID, event: "view", visitor_key: KEY, webdriver: false };

/** The failing `param` of a result, or "ok" when it passed. */
function paramOf(result: { ok: boolean; error?: { param?: string } }): string | undefined {
  return result.ok ? "ok" : result.error?.param;
}

describe("OUTREACH_TRACKING_ID_PATTERN", () => {
  it("accepts exactly 32 lowercase hex characters", () => {
    expect(OUTREACH_TRACKING_ID_PATTERN.test(ID)).toBe(true);
    expect(OUTREACH_TRACKING_ID_PATTERN.test(ID.slice(1))).toBe(false);
    expect(OUTREACH_TRACKING_ID_PATTERN.test(`${ID}0`)).toBe(false);
    expect(OUTREACH_TRACKING_ID_PATTERN.test(ID.toUpperCase())).toBe(false);
  });
});

describe("validateOutreachVisitRequest", () => {
  it("accepts both events", () => {
    expect(validateOutreachVisitRequest(REQUEST)).toEqual({ ok: true, value: REQUEST });
    expect(validateOutreachVisitRequest({ ...REQUEST, event: "engaged", webdriver: true }).ok).toBe(true);
  });

  it("refuses a non-object body naming body", () => {
    for (const body of [null, [], "x", 1]) expect(paramOf(validateOutreachVisitRequest(body))).toBe("body");
  });

  it("refuses an unknown field as unsupported_parameter", () => {
    const result = validateOutreachVisitRequest({ ...REQUEST, email: "a@example.com" });
    expect(result).toMatchObject({ ok: false, error: { code: "unsupported_parameter", param: "email" } });
  });

  it("names each missing or malformed field", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...REQUEST, tracking_id: ID.toUpperCase() }, "tracking_id"],
      [{ ...REQUEST, tracking_id: undefined }, "tracking_id"],
      [{ ...REQUEST, event: "click" }, "event"],
      [{ ...REQUEST, visitor_key: "short" }, "visitor_key"],
      [{ ...REQUEST, webdriver: "false" }, "webdriver"]
    ];
    for (const [body, param] of cases) {
      const result = validateOutreachVisitRequest(body);
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_value", param } });
    }
  });
});

describe("validateOutreachVisitListQuery", () => {
  const query = (text: string) => validateOutreachVisitListQuery(new URLSearchParams(text));

  it("accepts a tracking-ID query", () => {
    expect(query(`tracking_id=${ID}`)).toEqual({ ok: true, value: { kind: "tracking_id", tracking_id: ID } });
  });

  it("accepts a since query with the default and an explicit limit", () => {
    expect(query("since=2026-10-27T00:00:00Z")).toEqual({
      ok: true,
      value: { kind: "since", since: "2026-10-27T00:00:00Z", cursor: null, limit: 200 }
    });
    expect(query("since=2026-10-27T00:00:00Z&cursor=abc&limit=500")).toMatchObject({
      ok: true,
      value: { cursor: "abc", limit: 500 }
    });
  });

  it("refuses both, neither, paging with tracking_id, repeats, and bad values", () => {
    const cases: [string, string][] = [
      ["", "since"],
      [`tracking_id=${ID}&since=2026-10-27T00:00:00Z`, "tracking_id"],
      [`tracking_id=${ID}&cursor=abc`, "cursor"],
      [`tracking_id=${ID}&limit=5`, "limit"],
      [`tracking_id=${ID}&tracking_id=${ID}`, "tracking_id"],
      ["tracking_id=nothex", "tracking_id"],
      ["since=yesterday", "since"],
      ["since=2026-13-45T00:00:00Z", "since"],
      ["since=2026-10-27T00:00:00Z&limit=0", "limit"],
      ["since=2026-10-27T00:00:00Z&limit=501", "limit"],
      ["since=2026-10-27T00:00:00Z&limit=1.5", "limit"],
      ["since=2026-10-27T00:00:00Z&cursor=", "cursor"]
    ];
    for (const [text, param] of cases) {
      expect(query(text), text).toMatchObject({ ok: false, error: { code: "invalid_value", param } });
    }
  });

  it("refuses an unknown parameter as unsupported_parameter", () => {
    expect(query(`tracking_id=${ID}&email=x`)).toMatchObject({
      ok: false,
      error: { code: "unsupported_parameter", param: "email" }
    });
  });
});

describe("validateOutreachVisitList", () => {
  const visit = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    tracking_id: ID,
    event: "view",
    visitor_key: KEY,
    visited_at: "2026-10-27T12:00:00.000Z",
    user_agent: "Mozilla/5.0",
    webdriver: false,
    country: "US",
    asn: 7922,
    as_organization: "Comcast",
    automated_signals: []
  };

  it("accepts a page with and without a cursor", () => {
    expect(validateOutreachVisitList({ visits: [visit], next_cursor: "abc" }).ok).toBe(true);
    expect(
      validateOutreachVisitList({
        visits: [{ ...visit, user_agent: null, country: null, asn: null, as_organization: null, automated_signals: ["user_agent", "hosting_network"] }],
        next_cursor: null
      }).ok
    ).toBe(true);
  });

  it("refuses an unknown member, bad fields, and out-of-order signals", () => {
    const cases: [unknown, string][] = [
      [{ visits: [visit], next_cursor: null, total: 1 }, "total"],
      [{ visits: [{ ...visit, ip: "1.2.3.4" }], next_cursor: null }, "visits[0].ip"],
      [{ visits: [{ ...visit, country: "us" }], next_cursor: null }, "visits[0].country"],
      [{ visits: [{ ...visit, asn: 0 }], next_cursor: null }, "visits[0].asn"],
      [{ visits: [{ ...visit, automated_signals: ["webdriver", "user_agent"] }], next_cursor: null }, "visits[0].automated_signals"],
      [{ visits: [{ ...visit, automated_signals: ["robot"] }], next_cursor: null }, "visits[0].automated_signals[0]"],
      [{ visits: [visit], next_cursor: "" }, "next_cursor"]
    ];
    for (const [body, param] of cases) {
      expect(paramOf(validateOutreachVisitList(body))).toBe(param);
    }
  });
});
