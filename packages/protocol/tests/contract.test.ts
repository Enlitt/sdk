import { describe, expect, it } from "vitest";

import { buildWireContract, serializeWireContract, WIRE_CLOSED_SETS } from "../src/contract.js";

describe("generated wire contract", () => {
  it("matches the committed artifact byte for byte", async () => {
    await expect(serializeWireContract(buildWireContract())).toMatchFileSnapshot("../generated/contract.json");
  });

  it("sorts record keys and never registers other as a current member", () => {
    const contract = JSON.parse(serializeWireContract(buildWireContract())) as ReturnType<typeof buildWireContract>;
    expect(Object.keys(contract.error_codes)).toEqual(Object.keys(contract.error_codes).sort());
    expect(Object.keys(contract.closed_sets)).toEqual(Object.keys(contract.closed_sets).sort());
    for (const members of Object.values(WIRE_CLOSED_SETS)) expect(members).not.toContain("other");
  });
});
