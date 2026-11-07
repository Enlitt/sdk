import { describe, expect, it } from "vitest";

import { validateUsageResponse } from "../src/usage.js";

const body = {
  standard: { remaining_percent: 100, limit_cap_nano_usd: "1000000" },
  premium: { remaining_percent: 42, limit_cap_nano_usd: "500000" }
};

describe("validateUsageResponse", () => {
  it("accepts only bounded percentages and canonical NANOUSD", () => {
    expect(validateUsageResponse(body).ok).toBe(true);
    expect(validateUsageResponse({ ...body, premium: { ...body.premium, remaining_percent: 101 } }).ok).toBe(false);
    expect(validateUsageResponse({ ...body, premium: { ...body.premium, limit_cap_nano_usd: "01" } }).ok).toBe(false);
  });

  it("rejects future fields strictly and drops them tolerantly", () => {
    const future = { ...body, future: true, standard: { ...body.standard, detail: "future" } };
    expect(validateUsageResponse(future).ok).toBe(false);
    const tolerant = validateUsageResponse(future, { mode: "tolerant" });
    expect(tolerant).toEqual({ ok: true, value: body });
  });
});
