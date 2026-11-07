import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import {
  validateBeginPremiumOperationRequest,
  validateOpenAIResponse,
  validateReportPremiumTerminalRequest
} from "@enlitt/protocol";
import {
  EnlittAuthenticationError,
  EnlittAuthorizationError,
  EnlittError,
  EnlittInsufficientCreditsError,
  EnlittLimitExceededError,
  EnlittLoginRequiredError,
  EnlittRateLimitError,
  EnlittSubscriptionInactiveError
} from "../src/core/errors.js";
import { beginPremiumOperation, reportPremiumTerminalState } from "../src/core/premium.js";
import { createSseEventStream } from "../src/core/sse.js";
import { createInternalClient, requestEnlitt } from "../src/core/transport.js";
import { buildStandardRequest, mapStandardGenerateResponse, mapStandardStream } from "../src/vercel/standard-language-model.js";

// Runs the shared wire fixtures in packages/protocol/fixtures through the SDK.
// The directories are read at run time, so a new fixture is covered without
// editing this file. `fetch` is a stub answering with the fixture's own
// status, headers, and body; nothing touches the network.

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../protocol/fixtures");

interface Fixture {
  description: string;
  [key: string]: any;
}

function loadFixtures(directory: string): { name: string; fixture: Fixture }[] {
  return readdirSync(join(FIXTURE_ROOT, directory))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({ name: file, fixture: JSON.parse(readFileSync(join(FIXTURE_ROOT, directory, file), "utf8")) as Fixture }));
}

const CLIENT_OPTIONS = {
  secretKey: "sk_test_1234567890",
  baseUrl: "https://api.enlitt.test",
  session: { token: "session-token-123" },
  rateLimit: { maxAttempts: 1 }
} as const;

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Makes the stubbed `fetch` answer with a fixture's status, headers, and body. */
function answerWith(status: number, headers: Record<string, string>, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  fetchMock.mockImplementation(() => Promise.resolve(new Response(text, { status, headers })));
}

function sentBody(call = 0): unknown {
  return JSON.parse((fetchMock.mock.calls[call]![1]!).body as string);
}

// --- errors/ -----------------------------------------------------------------

const ERROR_CLASSES: Record<string, new (...args: never[]) => EnlittError> = {
  authentication: EnlittAuthenticationError,
  authorization: EnlittAuthorizationError,
  login_required: EnlittLoginRequiredError,
  insufficient_credits: EnlittInsufficientCreditsError,
  limit_exceeded: EnlittLimitExceededError,
  subscription_inactive: EnlittSubscriptionInactiveError,
  rate_limit: EnlittRateLimitError
};

describe("errors/ fixtures", () => {
  for (const { name, fixture } of loadFixtures("errors")) {
    it(`${name}: ${fixture.description}`, async () => {
      answerWith(fixture.http_status, fixture.headers ?? {}, fixture.body);
      const client = createInternalClient(CLIENT_OPTIONS);
      const thrown: unknown = await requestEnlitt(client, {
        path: "/v1/responses",
        body: {},
        callId: "fixture-call-id-0001",
        accept: "application/json"
      }).catch((error: unknown) => error);

      const expected = fixture.expected;
      expect(thrown, `${name} must reject with an EnlittError`).toBeInstanceOf(EnlittError);
      const error = thrown as EnlittError & Record<string, unknown>;
      if (expected.class === "generic") {
        expect(Object.getPrototypeOf(error), `${name} must be exactly the base EnlittError`).toBe(EnlittError.prototype);
      } else {
        expect(error, `${name} must be a ${expected.class} error`).toBeInstanceOf(ERROR_CLASSES[expected.class]!);
      }
      expect(error.code).toBe(expected.code);
      expect(error.retryable).toBe(expected.retryable);
      expect(error.retryAfterMs).toBe(expected.retry_after_ms);
      expect(error.authorizeUrl).toBe(expected.authorize_url);
      expect(error.admissibleMaxChargeNanoUsd).toBe(expected.admissible_max_charge_nano_usd);
      if (expected.message !== undefined) {
        expect(error.message.startsWith(expected.message)).toBe(true);
      }
      const requestId = fixture.headers?.["x-request-id"];
      if (requestId !== undefined) {
        expect(error.requestId).toBe(requestId);
      }
    });
  }
});

// --- streams/ ----------------------------------------------------------------

/** Renders a fixture's events as the SSE bytes the server would send. */
function renderSse(events: { event: string; data: unknown }[]): Uint8Array {
  const text = events
    .map((event) => `event: ${event.event}\ndata: ${typeof event.data === "string" ? event.data : JSON.stringify(event.data)}\n\n`)
    .join("");
  return new TextEncoder().encode(text);
}

function byteStream(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    }
  });
}

async function mapBytes(bytes: Uint8Array, chunkSize: number): Promise<LanguageModelV3StreamPart[]> {
  const reader = mapStandardStream(createSseEventStream(byteStream(bytes, chunkSize))).getReader();
  const parts: LanguageModelV3StreamPart[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

describe("streams/ fixtures", () => {
  for (const { name, fixture } of loadFixtures("streams")) {
    it(`${name}: ${fixture.description}`, async () => {
      const bytes = renderSse(fixture.events);
      const whole = await mapBytes(bytes, bytes.length);
      const expected = fixture.expected;

      if (expected.outcome === "invalid") {
        const errors = whole.filter((part) => part.type === "error") as { error: { code?: string } }[];
        expect(errors, `${name} must yield exactly one error part`).toHaveLength(1);
        expect(errors[0]!.error.code).toBe(expected.error_code);
      } else {
        const finishes = whole.filter((part) => part.type === "finish") as { finishReason: { unified: string } }[];
        expect(finishes, `${name} must yield exactly one finish part`).toHaveLength(1);
        expect(finishes[0]!.finishReason.unified).toBe(expected.finish_reason);
        if (expected.output_text !== undefined) {
          const text = whole.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("");
          expect(text).toBe(expected.output_text);
        }
        if (expected.function_calls !== undefined) {
          const calls = whole.flatMap((part) =>
            part.type === "tool-call" ? [{ call_id: part.toolCallId, name: part.toolName, arguments: part.input }] : []
          );
          expect(calls).toEqual(expected.function_calls);
        }
      }

      // The same bytes split into one-byte chunks must map to identical parts.
      expect(await mapBytes(bytes, 1)).toEqual(whole);
    });
  }
});

// --- responses/ --------------------------------------------------------------

describe("responses/ fixtures", () => {
  for (const { name, fixture } of loadFixtures("responses")) {
    it(`${name}: ${fixture.description}`, async () => {
      const client = createInternalClient(CLIENT_OPTIONS);
      switch (fixture.endpoint) {
        case "create-response": {
          const parsed = validateOpenAIResponse(fixture.body, { mode: "tolerant" });
          expect(parsed.ok, `${name} must parse tolerantly`).toBe(true);
          if (parsed.ok) {
            expect(() => mapStandardGenerateResponse(parsed.value)).not.toThrow();
          }
          break;
        }
        case "begin-operation": {
          answerWith(fixture.http_status, {}, fixture.body);
          const operation = await beginPremiumOperation(
            client,
            { maxCharge: "1000", provider: { id: "openai", model: "gpt-5" } },
            "fixture-call-id-0001"
          );
          expect(operation.operationId).toBe(fixture.body.operation_id);
          expect(operation.effectiveMaxChargeNanoUsd).toBe(fixture.body.effective_max_charge_nano_usd);
          expect(operation.terminalDeadline).toBe(fixture.body.terminal_deadline);
          break;
        }
        case "report-terminal": {
          answerWith(fixture.http_status, {}, fixture.body);
          const onTerminalReportError = vi.fn();
          await reportPremiumTerminalState(
            { ...client, onTerminalReportError },
            { operationId: "op_fixture_1", effectiveMaxChargeNanoUsd: "1000", terminalDeadline: "2026-09-29T12:00:00Z" },
            { reportId: "report-id-123456", status: "completed", chargeNanoUsd: "700" }
          );
          expect(onTerminalReportError).not.toHaveBeenCalled();
          break;
        }
        case "business-info":
          // The SDK has no business-account read; packages/cli/tests/wire-fixtures.test.ts covers these bodies.
          break;
        case "usage":
          // `usage()` is covered by its own tests; the fixture only needs to be well-formed JSON here.
          expect(fixture.body).toBeDefined();
          break;
        default:
          throw new Error(`${name}: no SDK handling for endpoint "${fixture.endpoint}"`);
      }
    });
  }
});

// --- requests/ ---------------------------------------------------------------

type RequestScenario = () => Promise<unknown>;

const PREMIUM_CLIENT = () => createInternalClient(CLIENT_OPTIONS);
const PROVIDER = { id: "openai", model: "gpt-5" };
const OPERATION = { operationId: "op_fixture_1", effectiveMaxChargeNanoUsd: "1000", terminalDeadline: "2026-09-29T12:00:00Z" };
const ADMITTED = {
  operation_id: "op_fixture_1",
  billing: "managed",
  report_terminal: true,
  effective_max_charge_nano_usd: "1000",
  reserved_nano_usd: "1000",
  terminal_deadline: "2026-09-29T12:00:00Z"
};
const SETTLED = {
  operation_id: "op_fixture_1",
  status: "completed",
  idempotent_replay: false,
  settlement: { captured_nano_usd: "0", released_nano_usd: "0", business_earnings_nano_usd: "0" }
};

/** Builds the SDK request for a begin scenario and returns what the SDK sent. */
function beginScenario(maxCharge: string): RequestScenario {
  return async () => {
    answerWith(200, {}, ADMITTED);
    await beginPremiumOperation(PREMIUM_CLIENT(), { maxCharge, provider: PROVIDER }, "fixture-call-id-0001");
    return sentBody();
  };
}

function reportScenario(status: "completed" | "failed", chargeNanoUsd: string): RequestScenario {
  return async () => {
    answerWith(200, {}, SETTLED);
    await reportPremiumTerminalState(
      // The fixed timing is irrelevant to the fixture; only fixture fields are compared below.
      PREMIUM_CLIENT(),
      OPERATION,
      { reportId: "report-id-123456", status, chargeNanoUsd }
    );
    // The SDK adds its own timing fact; the fixture covers the required fields only.
    const { timing: _timing, ...rest } = sentBody() as Record<string, unknown>;
    return rest;
  };
}

const MESSAGE_PROMPT = (content: unknown[]) => [{ role: "user" as const, content: content as never }];

/** One entry per valid fixture file: the SDK inputs that must produce its body. */
const SCENARIOS: Record<string, RequestScenario> = {
  "begin-operation--basic.json": beginScenario("1000"),
  "begin-operation--zero-max-charge.json": beginScenario("0"),
  "report-terminal--completed.json": reportScenario("completed", "700"),
  "report-terminal--failed-zero.json": reportScenario("failed", "0"),
  "create-response--text.json": async () =>
    buildStandardRequest({ prompt: MESSAGE_PROMPT([{ type: "text", text: "Hello" }]) }, {}, "fixture-call-id-0001"),
  "create-response--image-input.json": async () =>
    buildStandardRequest(
      {
        prompt: MESSAGE_PROMPT([
          { type: "text", text: "Describe this image." },
          { type: "file", mediaType: "image/png", data: new URL("https://example.com/image.png") }
        ])
      },
      {},
      "fixture-call-id-0001"
    ),
  "create-response--tools-and-results.json": async () =>
    buildStandardRequest(
      {
        prompt: [
          { role: "user", content: [{ type: "text", text: "What is the weather?" }] },
          {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "call_weather", toolName: "weather", input: { city: "Boston" } }]
          },
          {
            role: "tool",
            content: [{ type: "tool-result", toolCallId: "call_weather", toolName: "weather", output: { type: "text", value: "Sunny" } }]
          }
        ],
        tools: [{ type: "function", name: "weather", description: "Gets the weather.", inputSchema: { type: "object" } }]
      },
      {},
      "fixture-call-id-0001"
    )
};

describe("requests/ fixtures", () => {
  for (const { name, fixture } of loadFixtures("requests")) {
    if (fixture.valid === true) {
      it(`${name}: the SDK produces this valid body`, async () => {
        const scenario = SCENARIOS[name];
        expect(scenario, `${name} is a valid fixture with no scenario; add the SDK inputs that produce it`).toBeDefined();
        expect(await scenario!()).toEqual(fixture.body);
      });
    } else {
      it(`${name}: the protocol's strict validator refuses this invalid body`, () => {
        const validate = {
          "begin-operation": validateBeginPremiumOperationRequest,
          "report-terminal": validateReportPremiumTerminalRequest
        }[fixture.endpoint as string];
        if (validate !== undefined) {
          expect(validate(fixture.body).ok).toBe(false);
        } else {
          // create-response bodies are refused by the standard request validator.
          expect(() => buildStandardRequestFromBody(fixture.body)).toThrow();
        }
      });
    }
  }
});

/** Pushes a raw invalid body through the SDK's own strict validator via the protocol package. */
function buildStandardRequestFromBody(body: unknown): void {
  // Imported lazily so the file's top-level imports stay focused on SDK entry points.
  const result = validateStandardForTest(body);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

import { validateEnlittStandardRequest as validateStandardForTest } from "@enlitt/protocol";
