import { describe, expect, it } from "vitest";

import {
  CanonicalIntegerError,
  formatCanonicalInteger,
  isCanonicalIntegerString,
  parseCanonicalInteger,
  parsePositiveCanonicalInteger
} from "../src/canonical-integer.js";

describe("parseCanonicalInteger", () => {
  it("accepts zero and plain digit strings", () => {
    expect(parseCanonicalInteger("0")).toBe(0n);
    expect(parseCanonicalInteger("7")).toBe(7n);
    expect(parseCanonicalInteger("1000000000")).toBe(1_000_000_000n);
  });

  it("preserves values beyond Number.MAX_SAFE_INTEGER exactly", () => {
    const beyondDouble = "9007199254740993";
    expect(parseCanonicalInteger(beyondDouble)).toBe(9007199254740993n);
    expect(formatCanonicalInteger(parseCanonicalInteger(beyondDouble))).toBe(beyondDouble);
    // The reason the wire uses strings at all: the same value through a double
    // is a different number.
    expect(String(Number(beyondDouble))).not.toBe(beyondDouble);
  });

  it("rejects every noncanonical spelling of a number", () => {
    const noncanonical = [
      "",
      " 1",
      "1 ",
      "007",
      "-1",
      "+1",
      "1.0",
      "1e9",
      "0x10",
      "1_000",
      "١٢٣",
      "Infinity",
      "NaN"
    ];
    for (const value of noncanonical) {
      expect(() => parseCanonicalInteger(value)).toThrow(CanonicalIntegerError);
      expect(isCanonicalIntegerString(value)).toBe(false);
    }
  });

  it("rejects a number, a bigint, and null rather than coercing them", () => {
    for (const value of [1, 1n, null, undefined, {}, ["1"]]) {
      expect(() => parseCanonicalInteger(value)).toThrow(CanonicalIntegerError);
    }
  });

  it("names the field in the failure so a caller can point at it", () => {
    expect(() => parseCanonicalInteger("007", "charge.amount")).toThrow(/charge\.amount/);
  });
});

describe("parsePositiveCanonicalInteger", () => {
  it("accepts one and above", () => {
    expect(parsePositiveCanonicalInteger("1")).toBe(1n);
  });

  // A zero quote is not a quote. Rounding a strictly positive quote up is what
  // makes a per-call limit of zero an absolute block rather than a free pass.
  it("rejects zero", () => {
    expect(() => parsePositiveCanonicalInteger("0")).toThrow(CanonicalIntegerError);
  });
});

describe("formatCanonicalInteger", () => {
  it("round-trips every accepted string", () => {
    for (const value of ["0", "1", "10", "9007199254740993", "123456789012345678901234567890"]) {
      expect(formatCanonicalInteger(parseCanonicalInteger(value))).toBe(value);
    }
  });

  it("refuses a negative amount rather than signing it", () => {
    expect(() => formatCanonicalInteger(-1n)).toThrow(CanonicalIntegerError);
  });

  it("refuses a non-bigint, which is how a float would sneak onto the wire", () => {
    expect(() => formatCanonicalInteger(1 as unknown as bigint)).toThrow(CanonicalIntegerError);
  });
});
