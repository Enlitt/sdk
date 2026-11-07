/**
 * The CLI parses business reads with the same tolerant validator the SDK uses.
 * These tests run it over the shared protocol fixtures, so a fixture change that
 * the CLI cannot read fails here and not in a developer's terminal.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateBusinessDashboardInfo } from "@enlitt/protocol";
import { describe, expect, it } from "vitest";

import { loginAs, makeWorld, standardRoutes } from "../src/test-harness.js";

const FIXTURE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "protocol", "fixtures", "responses");

interface Fixture {
  readonly name: string;
  readonly body: unknown;
}

const fixtures: Fixture[] = readdirSync(FIXTURE_DIRECTORY)
  .filter((file) => file.startsWith("business-info") && file.endsWith(".json"))
  .map((file) => ({
    name: file,
    body: (JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, file), "utf8")) as { body: unknown }).body
  }));

describe("business-info fixtures", () => {
  it("finds the fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(2);
  });

  it.each(fixtures)("$name parses in tolerant mode", ({ body }) => {
    const result = validateBusinessDashboardInfo(body, { mode: "tolerant" });
    expect(result.ok, JSON.stringify(result.ok ? null : result.error)).toBe(true);
  });

  it.each(fixtures)("business info --json renders $name", async ({ body }) => {
    const world = await makeWorld();
    await loginAs(world);
    world.handler = standardRoutes((request) =>
      request.method === "GET" && request.path === "/v1/dashboard/business" ? { status: 200, body } : undefined
    );
    const json = await world.run(["business", "info", "--json"]);
    expect(json.code, json.stdout + json.stderr).toBe(0);
    expect(json.json).toBeDefined();
    const human = await world.run(["business", "info"]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout.length).toBeGreaterThan(0);
  });
});
