import { beforeEach, describe, expect, it } from "vitest";

import { dayString, DEFAULT_DAYS, eachDay, MAX_DAYS, parseDay, resolveOptionalRange, resolveTrafficRange } from "./traffic.js";
import { appDetail, appSummary, businessInfo, loginAs, makeWorld, standardRoutes } from "./test-harness.js";
import type { World } from "./test-harness.js";

const NOW = new Date("2026-06-15T12:00:00Z");

describe("day parsing", () => {
  it("accepts real calendar days only", () => {
    expect(dayString(parseDay("2026-02-28", "--from"))).toBe("2026-02-28");
    for (const bad of ["2026-02-30", "2026-13-01", "26-01-01", "2026-1-1", "", "2026-06-15T00:00:00Z"]) {
      expect(() => parseDay(bad, "--from"), bad).toThrow(/--from must be a date/);
    }
  });
});

describe("resolveTrafficRange", () => {
  it("defaults to the last 30 days ending today, as a half-open range", () => {
    const range = resolveTrafficRange({}, NOW);
    expect(range).toEqual({
      fromDay: "2026-05-17",
      toDay: "2026-06-15",
      from: "2026-05-17T00:00:00Z",
      to: "2026-06-16T00:00:00Z"
    });
    expect(eachDay(range)).toHaveLength(DEFAULT_DAYS);
  });

  it("--days 1 is today only", () => {
    expect(resolveTrafficRange({ days: "1" }, NOW)).toMatchObject({ fromDay: "2026-06-15", toDay: "2026-06-15" });
  });

  it("converts an inclusive --to into the midnight ending that day", () => {
    const range = resolveTrafficRange({ from: "2026-03-01", to: "2026-03-31" }, NOW);
    expect(range.from).toBe("2026-03-01T00:00:00Z");
    expect(range.to).toBe("2026-04-01T00:00:00Z");
    expect(eachDay(range)).toHaveLength(31);
    // Year and leap-day boundaries.
    expect(resolveTrafficRange({ from: "2027-12-31", to: "2027-12-31" }, NOW).to).toBe("2028-01-01T00:00:00Z");
    expect(resolveTrafficRange({ from: "2028-02-28", to: "2028-02-29" }, NOW).to).toBe("2028-03-01T00:00:00Z");
  });

  it("bounds --days to 1..3660 whole numbers", () => {
    expect(() => resolveTrafficRange({ days: "3660" }, NOW)).not.toThrow();
    for (const bad of ["0", "3661", "-1", "1.5", "abc", ""]) {
      expect(() => resolveTrafficRange({ days: bad }, NOW), bad).toThrow(/--days/);
    }
    expect(MAX_DAYS).toBe(3660);
  });

  it("refuses a span over 3660 days, a reversed range, and mixed or lone flags", () => {
    expect(() => resolveTrafficRange({ from: "2010-01-01", to: "2026-01-01" }, NOW)).toThrow(/at most 3660 days/);
    expect(() => resolveTrafficRange({ from: "2026-03-02", to: "2026-03-01" }, NOW)).toThrow(/not be before/);
    expect(() => resolveTrafficRange({ days: "5", from: "2026-03-01", to: "2026-03-02" }, NOW)).toThrow(/not both/);
    expect(() => resolveTrafficRange({ from: "2026-03-01" }, NOW)).toThrow(/go together/);
    expect(() => resolveTrafficRange({ to: "2026-03-01" }, NOW)).toThrow(/go together/);
  });
});

describe("resolveOptionalRange", () => {
  it("is undefined without flags, runs to today with --from alone, and refuses --to alone", () => {
    expect(resolveOptionalRange({}, NOW)).toBeUndefined();
    expect(resolveOptionalRange({ from: "2026-06-10" }, NOW)).toMatchObject({ toDay: "2026-06-15", to: "2026-06-16T00:00:00Z" });
    expect(() => resolveOptionalRange({ to: "2026-06-10" }, NOW)).toThrow(/--to needs --from/);
  });
});

describe("traffic command", () => {
  let world: World;
  beforeEach(async () => {
    world = await makeWorld();
    await loginAs(world);
  });

  it("zero-fills days the server omits, in order, with string money", async () => {
    world.handler = standardRoutes((request) =>
      request.path === "/v1/dashboard/business"
        ? {
            status: 200,
            body: businessInfo({
              traffic: {
                daily_visitors: [{ date: "2026-06-14", count: 7 }],
                daily_usage: [{ date: "2026-06-13", standard_requests: 4, premium_requests: 2, premium_earnings_nano_usd: "900" }],
                usage: { standard: { requests: 4, used_nano_usd: "1" }, premium: { requests: 2, used_nano_usd: "2", earnings_nano_usd: "900" } }
              }
            })
          }
        : undefined
    );
    const result = await world.run(["traffic", "--days", "3", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({
      range: { from: "2026-06-13T00:00:00Z", to: "2026-06-16T00:00:00Z" },
      days: [
        { date: "2026-06-13", visitors: 0, standard_requests: 4, premium_requests: 2, premium_earnings_nano_usd: "900" },
        { date: "2026-06-14", visitors: 7, standard_requests: 0, premium_requests: 0, premium_earnings_nano_usd: "0" },
        { date: "2026-06-15", visitors: 0, standard_requests: 0, premium_requests: 0, premium_earnings_nano_usd: "0" }
      ]
    });
    const request = world.requests.find((r) => r.path === "/v1/dashboard/business");
    expect(request?.query.get("from")).toBe("2026-06-13T00:00:00Z");
    expect(request?.query.get("to")).toBe("2026-06-16T00:00:00Z");
    const human = await world.run(["traffic", "--days", "3"]);
    expect(human.stdout).toContain("2026-06-13 to 2026-06-15 (UTC)");
  });

  it("--app follows the analytics cursor and zero-fills", async () => {
    const day = (date: string, visitors: number): Record<string, unknown> => ({
      day: date,
      daily_visitors: visitors,
      standard_requests: 1,
      premium_requests: 0,
      standard_used_nano_usd: "10",
      premium_used_nano_usd: "0",
      business_earnings_nano_usd: "0"
    });
    const analytics = (days: Record<string, unknown>[], next: string | null): Record<string, unknown> => ({
      range: { from: "2026-06-13T00:00:00Z", to: "2026-06-16T00:00:00Z", timezone: "UTC" },
      days,
      next_cursor: next
    });
    world.handler = standardRoutes((request) => {
      if (request.path === "/v1/dashboard/business/applications/app_1") {
        return request.query.get("cursor") === "next"
          ? { status: 200, body: appDetail({ analytics: analytics([day("2026-06-15", 5)], null) }) }
          : { status: 200, body: appDetail({ analytics: analytics([day("2026-06-13", 3)], "next") }) };
      }
      return undefined;
    });
    const result = await world.run(["traffic", "--app", "app_1", "--days", "3", "--json"]);
    expect(result.code).toBe(0);
    const days = (result.json as { days: { date: string; visitors: number }[] }).days;
    expect(days.map((d) => [d.date, d.visitors])).toEqual([["2026-06-13", 3], ["2026-06-14", 0], ["2026-06-15", 5]]);
    const detailRequests = world.requests.filter((r) => r.path.endsWith("/applications/app_1"));
    expect(detailRequests).toHaveLength(2);
    expect(detailRequests[1]?.query.get("from")).toBe("2026-06-13T00:00:00Z");
  });

  it("--app for an application missing from this business is not_found", async () => {
    world.handler = standardRoutes((request) =>
      request.path === "/v1/dashboard/business/applications/app_zzz" ? { status: 200, body: appDetail({ id: "app_zzz" }) } : undefined
    );
    const result = await world.run(["traffic", "--app", "app_zzz", "--json"]);
    expect(result.json).toMatchObject({ error: { code: "not_found" } });
  });

  it("mixing --days with --from/--to is a usage error that sends nothing", async () => {
    const result = await world.run(["traffic", "--days", "5", "--from", "2026-06-01", "--to", "2026-06-02"]);
    expect(result.code).toBe(2);
    expect(world.requests).toHaveLength(0);
    expect(appSummary()).toBeDefined();
  });
});
