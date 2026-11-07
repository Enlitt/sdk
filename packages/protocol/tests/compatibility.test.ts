import { describe, expect, it } from "vitest";

import {
  ENLITT_API_VERSION,
  ENLITT_VERSION_HEADER,
  UNKNOWN_ENUM_VALUE,
  UNRECOGNIZED_ERROR_CODE,
  type ParseOptions,
  type Readable,
  type UnknownVariant
} from "../src/compatibility.js";

describe("compatibility constants", () => {
  it("publishes the pinned v1 header and reserved tolerant-reading values", () => {
    expect(ENLITT_API_VERSION).toBe("2026-10-05");
    expect(ENLITT_VERSION_HEADER).toBe("Enlitt-Version");
    expect(UNKNOWN_ENUM_VALUE).toBe("other");
    expect(UNRECOGNIZED_ERROR_CODE).toBe("unrecognized");
  });

  it("keeps the shared parser signatures usable by response validators", () => {
    const options: ParseOptions = { mode: "tolerant" };
    const readable: Readable<"known"> = UNKNOWN_ENUM_VALUE;
    const unknown: UnknownVariant = { unknown: true, type: "future.variant" };
    expect(options.mode).toBe("tolerant");
    expect(readable).toBe("other");
    expect(unknown).toEqual({ unknown: true, type: "future.variant" });
  });
});
