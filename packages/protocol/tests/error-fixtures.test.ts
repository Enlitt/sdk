import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  classifyEnlittErrorResponse,
  ENLITT_ERROR_CODE_NAMES,
  ENLITT_ERROR_CODES
} from "../src/errors.js";

const ERRORS_DIRECTORY = fileURLToPath(new URL("../fixtures/errors/", import.meta.url));

interface ErrorFixture {
  readonly description: string;
  readonly http_status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly expected: {
    readonly code: string;
    readonly code_recognized: boolean;
    readonly class: string;
    readonly retryable: boolean;
    readonly retry_after_ms?: number;
    readonly authorize_url?: string;
    readonly admissible_max_charge_nano_usd?: string;
    readonly limit_rule?: string;
    readonly message?: string;
  };
}

async function readFixtures(): Promise<ReadonlyMap<string, ErrorFixture>> {
  const names = (await readdir(ERRORS_DIRECTORY)).sort();
  const fixtures = await Promise.all(
    names.map(async (name) => {
      expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/);
      const bytes = await readFile(new URL(`../fixtures/errors/${name}`, import.meta.url), "utf8");
      const fixture = JSON.parse(bytes) as ErrorFixture;
      expect(bytes).toBe(`${JSON.stringify(fixture, null, 2)}\n`);
      return [name, fixture] as const;
    })
  );
  return new Map(fixtures);
}

function errorExtension(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const error = (body as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return undefined;
  const extension = (error as Record<string, unknown>).enlitt;
  return typeof extension === "object" && extension !== null && !Array.isArray(extension)
    ? (extension as Record<string, unknown>)
    : undefined;
}

describe("error fixtures", () => {
  it("covers every frozen code and every required unknown-error scenario", async () => {
    const fixtures = await readFixtures();
    for (const code of ENLITT_ERROR_CODE_NAMES) {
      expect(fixtures.has(`code-${code.replaceAll("_", "-")}.json`)).toBe(true);
    }
    for (const name of [
      "rate-limit-retry-after-2.json",
      "unknown-code-5xx.json",
      "unknown-code-4xx.json",
      "unknown-code-429.json",
      "unknown-credit-refusal.json",
      "null-code-500.json",
      "html-body-502.json"
    ]) {
      expect(fixtures.has(name)).toBe(true);
    }
  });

  it("makes every error fixture byte-stable and classifier-compatible", async () => {
    const fixtures = await readFixtures();
    for (const [name, fixture] of fixtures) {
      const classified = classifyEnlittErrorResponse(fixture.http_status, fixture.body);
      if (name === "html-body-502.json") {
        expect(classified).toBeNull();
        continue;
      }

      expect(classified).not.toBeNull();
      expect(classified).toMatchObject({
        code: fixture.expected.code,
        recognized: fixture.expected.code_recognized,
        status: fixture.http_status,
        retryable: fixture.expected.retryable,
        ...(fixture.expected.authorize_url === undefined
          ? {}
          : { authorizeUrl: fixture.expected.authorize_url }),
        ...(fixture.expected.admissible_max_charge_nano_usd === undefined
          ? {}
          : { admissibleMaxChargeNanoUsd: fixture.expected.admissible_max_charge_nano_usd }),
        ...(fixture.expected.limit_rule === undefined ? {} : { limitRule: fixture.expected.limit_rule })
      });
    }
  });

  it("derives all known-fixture transport facts from the frozen record", async () => {
    const fixtures = await readFixtures();
    for (const code of ENLITT_ERROR_CODE_NAMES) {
      const fixture = fixtures.get(`code-${code.replaceAll("_", "-")}.json`);
      expect(fixture).toBeDefined();
      if (fixture === undefined) continue;
      const definition = ENLITT_ERROR_CODES[code];
      const extension = errorExtension(fixture.body);

      expect(fixture.http_status).toBe(definition.status);
      expect(Object.hasOwn(fixture.headers, "retry-after")).toBe(definition.retryAfter === "required");
      if (definition.retryAfter === "required") {
        expect(fixture.expected.retry_after_ms).toBe(Number(fixture.headers["retry-after"]) * 1000);
      } else {
        expect(fixture.expected.retry_after_ms).toBeUndefined();
      }
      expect(typeof extension?.authorize_url === "string").toBe(definition.authorizeUrl === "allowed");
      expect(typeof extension?.admissible_max_charge_nano_usd === "string").toBe(
        definition.admissibleMaxCharge === "allowed"
      );
      expect(typeof extension?.limit_rule === "string").toBe(definition.limitRule === "required");
    }
  });
});
