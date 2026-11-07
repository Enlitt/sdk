import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FIXTURE_ENDPOINTS } from "../src/contract.js";
import {
  checkResponseStreamOrdering,
  type StreamOrderingEvent,
  validateResponseStreamEvent
} from "../src/response-stream.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/", import.meta.url));
const FIXTURE_DIRECTORIES = ["requests", "responses", "streams"] as const;
const ENDPOINTS = ["create-response", "begin-operation", "report-terminal", "usage", "business-info"] as const;
const SCENARIO = "[a-z0-9]+(?:-[a-z0-9]+)*";
const FIXTURE_NAME = new RegExp(`^(${ENDPOINTS.join("|")})--(${SCENARIO})\\.json$`);

type FixtureDirectory = (typeof FIXTURE_DIRECTORIES)[number];
type FixtureEndpoint = (typeof ENDPOINTS)[number];

interface RequestFixture {
  readonly description: string;
  readonly endpoint: FixtureEndpoint;
  readonly valid: boolean;
  readonly error_param?: string;
  readonly body: unknown;
}

interface ResponseFixture {
  readonly description: string;
  readonly endpoint: FixtureEndpoint;
  readonly http_status: number;
  readonly future: boolean;
  readonly body: unknown;
  readonly expected_tolerant?: unknown;
}

interface StreamFixture {
  readonly description: string;
  readonly endpoint: "create-response";
  readonly future: boolean;
  readonly events: readonly { readonly event: string; readonly data: unknown }[];
  readonly expected: {
    readonly outcome: "completed" | "incomplete" | "failed" | "invalid";
    readonly finish_reason?: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
    readonly output_text?: string;
    readonly function_calls?: readonly { readonly call_id: string; readonly name: string; readonly arguments: string }[];
    readonly error_code?: string;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}

async function fixtureFiles(directory: FixtureDirectory): Promise<readonly string[]> {
  const entries = await readdir(`${FIXTURE_ROOT}/${directory}`, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
}

async function readFixture(directory: FixtureDirectory, file: string): Promise<unknown> {
  const source = await readFile(`${FIXTURE_ROOT}/${directory}/${file}`, "utf8");
  const parsed: unknown = JSON.parse(source);
  expect(source).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

async function fixtures<T>(directory: FixtureDirectory): Promise<readonly [string, T][]> {
  return Promise.all((await fixtureFiles(directory)).map(async (file) => [file, await readFixture(directory, file) as T] as const));
}

function expectDescription(value: unknown): void {
  expect(typeof value).toBe("string");
  expect(value).toMatch(/\.$/);
}

describe("shared wire fixture layout", () => {
  it("keeps the C1 fixture directories, names, and JSON bytes canonical", async () => {
    const rootEntries = await readdir(FIXTURE_ROOT, { withFileTypes: true });
    expect(rootEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()).toEqual([
      "errors", "requests", "responses", "streams"
    ]);
    for (const directory of FIXTURE_DIRECTORIES) {
      const files = await fixtureFiles(directory);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(file).toMatch(FIXTURE_NAME);
        await readFixture(directory, file);
      }
    }
  });

  it("uses exactly the documented request fixture shape", async () => {
    for (const [file, fixture] of await fixtures<RequestFixture>("requests")) {
      expect(isPlainObject(fixture)).toBe(true);
      if (!isPlainObject(fixture)) continue;
      expectDescription(fixture.description);
      expect(fixture.endpoint).toBe(file.split("--", 1)[0]);
      expect(hasOnlyKeys(fixture, fixture.valid === false
        ? ["description", "endpoint", "valid", "error_param", "body"]
        : ["description", "endpoint", "valid", "body"])).toBe(true);
      if (fixture.valid === false) expect(typeof fixture.error_param).toBe("string");
    }
  });

  it("uses exactly the documented response fixture shape", async () => {
    for (const [file, fixture] of await fixtures<ResponseFixture>("responses")) {
      expect(isPlainObject(fixture)).toBe(true);
      if (!isPlainObject(fixture)) continue;
      expectDescription(fixture.description);
      expect(fixture.endpoint).toBe(file.split("--", 1)[0]);
      expect(Number.isInteger(fixture.http_status) && fixture.http_status >= 200 && fixture.http_status < 300).toBe(true);
      expect(hasOnlyKeys(fixture, fixture.future
        ? ["description", "endpoint", "http_status", "future", "body", "expected_tolerant"]
        : ["description", "endpoint", "http_status", "future", "body"])).toBe(true);
      if (fixture.future) expect(fixture).toHaveProperty("expected_tolerant");
    }
  });

  it("uses exactly the documented stream fixture shape", async () => {
    for (const [file, fixture] of await fixtures<StreamFixture>("streams")) {
      expect(isPlainObject(fixture)).toBe(true);
      if (!isPlainObject(fixture)) continue;
      expectDescription(fixture.description);
      expect(file).toMatch(/^create-response--/);
      expect(fixture.endpoint).toBe("create-response");
      expect(Array.isArray(fixture.events) && fixture.events.length > 0).toBe(true);
      expect(isPlainObject(fixture.expected)).toBe(true);
      if (!isPlainObject(fixture.expected)) continue;
      const expectedKeys = fixture.expected.outcome === "invalid"
        ? ["outcome", "error_code"]
        : ["outcome", "finish_reason", "output_text", "function_calls"];
      expect(Object.keys(fixture.expected).every((key) => expectedKeys.includes(key))).toBe(true);
      if (fixture.expected.outcome === "invalid") {
        expect(fixture.expected.error_code).toBe("malformed_response");
      } else {
        expect(typeof fixture.expected.finish_reason).toBe("string");
      }
    }
  });
});

describe("shared request fixtures", () => {
  it("matches each fixture's strict request validation expectation", async () => {
    for (const [, fixture] of await fixtures<RequestFixture>("requests")) {
      const validator = FIXTURE_ENDPOINTS[fixture.endpoint].validateRequest;
      expect(validator).not.toBeNull();
      if (validator === null) continue;
      const result = validator(fixture.body);
      expect(result.ok).toBe(fixture.valid);
      if (!fixture.valid && !result.ok) expect(result.error?.param).toBe(fixture.error_param);
    }
  });
});

describe("shared response fixtures", () => {
  it("runs every response fixture through the endpoint registry", async () => {
    for (const [, fixture] of await fixtures<ResponseFixture>("responses")) {
      const validator = FIXTURE_ENDPOINTS[fixture.endpoint].validateResponse;
      const strict = validator(fixture.body);
      expect(strict.ok).toBe(!fixture.future);
      const tolerant = validator(fixture.body, { mode: "tolerant" });
      expect(tolerant.ok).toBe(true);
      if (tolerant.ok) expect(tolerant.value).toEqual(fixture.future ? fixture.expected_tolerant : strict.ok ? strict.value : undefined);
    }
  });
});

describe("shared stream fixtures", () => {
  it("validates every event and applies ordering through future events", async () => {
    for (const [, fixture] of await fixtures<StreamFixture>("streams")) {
      const parsed: StreamOrderingEvent[] = [];
      let outputText = "";
      const functionCallSeed = new Map<string, { call_id: string; name: string }>();
      const functionArguments = new Map<string, string>();
      let eventValid = true;
      for (const event of fixture.events) {
        expect(event.event).toBe(isPlainObject(event.data) ? event.data.type : undefined);
        const result = validateResponseStreamEvent(event.data, fixture.future ? { mode: "tolerant" } : undefined);
        if (!result.ok) {
          eventValid = false;
          continue;
        }
        parsed.push(result.value);
        if (result.value.type === "response.output_text.delta" && "delta" in result.value) outputText += result.value.delta;
        if (result.value.type === "response.output_item.added" && "item" in result.value && result.value.item.type === "function_call" && "id" in result.value.item) {
          functionCallSeed.set(result.value.item.id, { call_id: result.value.item.call_id, name: result.value.item.name });
        }
        if (result.value.type === "response.function_call_arguments.done" && "item_id" in result.value && "arguments" in result.value) {
          functionArguments.set(result.value.item_id, result.value.arguments);
        }
      }

      const ordering = eventValid ? checkResponseStreamOrdering(parsed) : { ok: false as const };
      expect(ordering.ok).toBe(fixture.expected.outcome !== "invalid");
      if (fixture.expected.outcome === "invalid") continue;

      const terminal = parsed.at(-1);
      expect(terminal?.type).toBe(`response.${fixture.expected.outcome}`);
      const finishReason = fixture.expected.outcome === "failed"
        ? "error"
        : fixture.expected.outcome === "incomplete"
          ? "length"
          : functionCallSeed.size > 0 ? "tool-calls" : "stop";
      expect(finishReason).toBe(fixture.expected.finish_reason);
      if (fixture.expected.output_text !== undefined) expect(outputText).toBe(fixture.expected.output_text);
      if (fixture.expected.function_calls !== undefined) {
        expect([...functionCallSeed].map(([itemId, call]) => ({ ...call, arguments: functionArguments.get(itemId) ?? "" })))
          .toEqual(fixture.expected.function_calls);
      }
    }
  });
});
