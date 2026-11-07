import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { IDEMPOTENCY_KEY_MAX_LENGTH, IDEMPOTENCY_KEY_MIN_LENGTH } from "@enlitt/protocol";
import { EnlittConfigurationError } from "../core/errors.js";
import { runWithEnlittSession } from "../core/session.js";
import * as languageModel from "./language-model.js";
import { ENLITT_STANDARD_MODEL, enlitt, readEnlittCallOptions, resolveCallId } from "./language-model.js";

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
  delete process.env.ENLITT_SECRET_KEY;
  delete process.env.ENLITT_BASE_URL;
}

beforeEach(() => {
  resetEnv();
});

afterEach(() => {
  resetEnv();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A well-formed OpenAI-shaped response body, minimal enough to satisfy
// `validateOpenAIResponse` for a `doGenerate` call through the real standard
// model — used only to prove requests actually reach the network layer with
// the expected headers, never to test response mapping (that belongs to
// `internal/standard-language-model.test.ts`).
function minimalResponseBody(): unknown {
  return {
    id: "resp_1",
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: "enlitt-standard",
    output: [],
    metadata: {}
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function minimalParams(overrides: Partial<LanguageModelV3CallOptions> = {}): LanguageModelV3CallOptions {
  return { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], ...overrides };
}

/** A minimal conforming `LanguageModelV3` for premium-mode tests, never actually invoked in most of them. */
function fakeProviderModel(overrides: Partial<LanguageModelV3> = {}): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "openai-compatible",
    modelId: "gpt-4o",
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(),
    ...overrides
  };
}

// --- enlitt() ---------------------------------------------------------

describe("enlitt()", () => {
  it('returns the standard model for "enlitt-standard"', () => {
    process.env.ENLITT_SECRET_KEY = "sk_test_1234567890";
    const model = enlitt(ENLITT_STANDARD_MODEL);
    expect(model.provider).toBe("enlitt");
    expect(model.modelId).toBe(ENLITT_STANDARD_MODEL);
  });

  it("transparently wraps a conforming provider model in premium mode", () => {
    process.env.ENLITT_SECRET_KEY = "sk_test_1234567890";
    const provider = fakeProviderModel();
    const model = enlitt(provider);
    // Premium middleware passes the wrapped model's own identity through unchanged.
    expect(model.provider).toBe(provider.provider);
    expect(model.modelId).toBe(provider.modelId);
    expect(model).not.toBe(provider);
  });

  it("fails in a simulated browser environment before any other work, including secret resolution", () => {
    // No secret configured at all: if the browser check ran after secret
    // resolution, this would fail with a *different* message than the
    // browser-specific one, so asserting the exact configuration error text
    // proves the browser check wins the race.
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    expect(() => enlitt(ENLITT_STANDARD_MODEL)).toThrow(EnlittConfigurationError);
    try {
      enlitt(ENLITT_STANDARD_MODEL);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/browser/i);
    }
  });

  it("blocks standard mode locally with no secret configured, before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => enlitt(ENLITT_STANDARD_MODEL)).toThrow(EnlittConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks premium mode locally with no secret configured, before the provider is ever invoked", () => {
    const provider = fakeProviderModel();
    expect(() => enlitt(provider)).toThrow(EnlittConfigurationError);
    expect(provider.doGenerate).not.toHaveBeenCalled();
    expect(provider.doStream).not.toHaveBeenCalled();
  });

  it("resolves baseUrl with option > ENLITT_BASE_URL > deployed default precedence", async () => {
    process.env.ENLITT_SECRET_KEY = "sk_test_1234567890";

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(minimalResponseBody()));
    vi.stubGlobal("fetch", fetchMock);

    // Deployed default, when neither the option nor the environment names one.
    await enlitt(ENLITT_STANDARD_MODEL, { session: { token: "t" } }).doGenerate(minimalParams());
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/^https:\/\/api\.enlitt\.com\//);

    // ENLITT_BASE_URL wins over the deployed default.
    process.env.ENLITT_BASE_URL = "https://env.example";
    await enlitt(ENLITT_STANDARD_MODEL, { session: { token: "t" } }).doGenerate(minimalParams());
    expect(String(fetchMock.mock.calls[1]![0])).toMatch(/^https:\/\/env\.example\//);

    // The explicit option wins over ENLITT_BASE_URL.
    await enlitt(ENLITT_STANDARD_MODEL, { baseUrl: "https://option.example", session: { token: "t" } }).doGenerate(minimalParams());
    expect(String(fetchMock.mock.calls[2]![0])).toMatch(/^https:\/\/option\.example\//);
  });

  it("fails at construction on a non-local http: base URL, with no environment override", () => {
    process.env.ENLITT_SECRET_KEY = "sk_test_1234567890";
    expect(() => enlitt(ENLITT_STANDARD_MODEL, { baseUrl: "http://not-local.example" })).toThrow(
      EnlittConfigurationError
    );
  });

  it("fails at construction on a malformed base URL", () => {
    process.env.ENLITT_SECRET_KEY = "sk_test_1234567890";
    expect(() => enlitt(ENLITT_STANDARD_MODEL, { baseUrl: "not a url" })).toThrow(EnlittConfigurationError);
  });

  it("accepts http: for localhost", async () => {
    process.env.ENLITT_SECRET_KEY = "sk_test_1234567890";
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(minimalResponseBody()));
    vi.stubGlobal("fetch", fetchMock);
    await enlitt(ENLITT_STANDARD_MODEL, { baseUrl: "http://localhost:3000", session: { token: "t" } }).doGenerate(minimalParams());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('"enlitt-standard" is the only standard model string, and the module exports exactly one factory and no OpenAI-shaped client', () => {
    expect(ENLITT_STANDARD_MODEL).toBe("enlitt-standard");
    const exported = Object.keys(languageModel);
    const factoryExports = exported.filter((name) => typeof (languageModel as Record<string, unknown>)[name] === "function");
    // The only functions this module exports are the one model factory and
    // the two per-call helpers `readEnlittCallOptions`/`resolveCallId` — no
    // second factory, and nothing shaped like an OpenAI client constructor.
    expect(factoryExports.sort()).toEqual(["enlitt", "readEnlittCallOptions", "resolveCallId"]);
  });

  it("produces byte-identical requests and the identical header for an explicit session and an ambient middleware session", async () => {
    process.env.ENLITT_SECRET_KEY = "sk_test_1234567890";
    const token = "same-session-token-123";

    const capturedInits: RequestInit[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedInits.push(init!);
      return jsonResponse(minimalResponseBody());
    });
    vi.stubGlobal("fetch", fetchMock);

    const params = minimalParams({ providerOptions: { enlitt: { idempotencyKey: "fixed-idempotency-key-000001" } } });

    // Explicit session.
    const explicitModel = enlitt(ENLITT_STANDARD_MODEL, { session: { token } });
    await explicitModel.doGenerate(params);

    // Ambient session via the middleware's own context helper.
    await runWithEnlittSession({ token }, async () => {
      const ambientModel = enlitt(ENLITT_STANDARD_MODEL);
      await ambientModel.doGenerate(params);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [explicitInit, ambientInit] = capturedInits;
    const explicitHeaders = new Headers(explicitInit!.headers);
    const ambientHeaders = new Headers(ambientInit!.headers);

    expect(explicitHeaders.get("X-Enlitt-User-Authorization")).toBe(`Bearer ${token}`);
    expect(explicitHeaders.get("X-Enlitt-User-Authorization")).toBe(ambientHeaders.get("X-Enlitt-User-Authorization"));
    expect(explicitHeaders.get("Authorization")).toBe(ambientHeaders.get("Authorization"));
    expect(explicitHeaders.get("Idempotency-Key")).toBe(ambientHeaders.get("Idempotency-Key"));
    expect(explicitInit!.body).toBe(ambientInit!.body);
  });
});

// --- readEnlittCallOptions() -------------------------------------------

describe("readEnlittCallOptions()", () => {
  it("returns an empty result in standard mode when no enlitt options are supplied", () => {
    expect(readEnlittCallOptions(undefined, "standard")).toEqual({});
    expect(readEnlittCallOptions({}, "standard")).toEqual({});
  });

  it("requires maxCharge in premium mode even when no enlitt options are supplied at all", () => {
    expect(() => readEnlittCallOptions(undefined, "premium")).toThrow(EnlittConfigurationError);
    expect(() => readEnlittCallOptions({}, "premium")).toThrow(EnlittConfigurationError);
  });

  describe("idempotencyKey", () => {
    it("is optional in both modes", () => {
      expect(readEnlittCallOptions({ enlitt: {} }, "standard")).toEqual({});
      expect(
        readEnlittCallOptions(
          { enlitt: { maxCharge: "100" } },
          "premium"
        ).idempotencyKey
      ).toBeUndefined();
    });

    it("accepts a key from the protocol's own floor up to 200 visible ASCII characters", () => {
      const key = "a".repeat(IDEMPOTENCY_KEY_MIN_LENGTH);
      expect(readEnlittCallOptions({ enlitt: { idempotencyKey: key } }, "standard").idempotencyKey).toBe(key);
      const longKey = "b".repeat(200);
      expect(readEnlittCallOptions({ enlitt: { idempotencyKey: longKey } }, "standard").idempotencyKey).toBe(longKey);
    });

    it("rejects a key under the protocol's floor or over 200 characters, or containing non-visible-ASCII", () => {
      expect(() => readEnlittCallOptions({ enlitt: { idempotencyKey: "short" } }, "standard")).toThrow(
        EnlittConfigurationError
      );
      // The boundary that made the two bounds disagree: this used to be
      // accepted here and then rejected as the derived ID, one character
      // under the protocol's floor.
      expect(() =>
        readEnlittCallOptions({ enlitt: { idempotencyKey: "a".repeat(IDEMPOTENCY_KEY_MIN_LENGTH - 1) } }, "standard")
      ).toThrow(EnlittConfigurationError);
      expect(() => readEnlittCallOptions({ enlitt: { idempotencyKey: "x".repeat(201) } }, "standard")).toThrow(
        EnlittConfigurationError
      );
      expect(() => readEnlittCallOptions({ enlitt: { idempotencyKey: "has space in it!" } }, "standard")).toThrow(
        EnlittConfigurationError
      );
    });

    it("makes every ID derived from an accepted key satisfy the protocol bound by construction", () => {
      // The shortest accepted key with the shortest possible suffix: if the
      // two bounds ever disagree again, this is where it shows.
      const shortest = "a".repeat(IDEMPOTENCY_KEY_MIN_LENGTH);
      const options = readEnlittCallOptions({ enlitt: { idempotencyKey: shortest } }, "standard");
      const id = resolveCallId(options, minimalParams());

      expect(id.length).toBeGreaterThanOrEqual(IDEMPOTENCY_KEY_MIN_LENGTH);
      expect(id.length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_MAX_LENGTH);
    });
  });

  describe("maxCharge and price", () => {
    it("requires maxCharge or a constant price in premium and rejects both in standard", () => {
      expect(() => readEnlittCallOptions({ enlitt: {} }, "premium")).toThrow(EnlittConfigurationError);
      expect(() => readEnlittCallOptions({ enlitt: { maxCharge: "100" } }, "standard")).toThrow(EnlittConfigurationError);
      expect(() => readEnlittCallOptions({ enlitt: { price: "100" } }, "standard")).toThrow(EnlittConfigurationError);
    });

    it("rejects the removed charge option as unrecognized", () => {
      expect(() =>
        readEnlittCallOptions({ enlitt: { charge: { amount: "100" }, maxCharge: "100" } as never }, "premium")
      ).toThrow(/not a recognized/);
    });

    it("accepts a canonical nonnegative integer string, including zero", () => {
      expect(readEnlittCallOptions({ enlitt: { maxCharge: "12345" } }, "premium").maxCharge).toBe("12345");
      expect(readEnlittCallOptions({ enlitt: { maxCharge: "0" } }, "premium").maxCharge).toBe("0");
    });

    it("accepts amounts beyond JavaScript's safe-integer range without precision loss", () => {
      const huge = "123456789012345678901234567890";
      expect(readEnlittCallOptions({ enlitt: { maxCharge: huge } }, "premium").maxCharge).toBe(huge);
    });

    it.each([
      ["a JSON number", 100],
      ["a signed value", "+100"],
      ["a negative value", "-100"],
      ["a fractional value", "1.5"],
      ["an exponent", "1e2"],
      ["whitespace", " 100"],
      ["a noncanonical leading zero", "0100"],
      ["an empty string", ""]
    ])("rejects a maxCharge that is %s", (_label, amount) => {
      expect(() => readEnlittCallOptions({ enlitt: { maxCharge: amount } }, "premium")).toThrow(
        EnlittConfigurationError
      );
    });

    it("defaults maxCharge to a constant price", () => {
      const result = readEnlittCallOptions({ enlitt: { price: "700" } }, "premium");
      expect(result.maxCharge).toBe("700");
      expect(result.price).toBe("700");
    });

    it("rejects a constant price above maxCharge", () => {
      expect(() => readEnlittCallOptions({ enlitt: { maxCharge: "5", price: "6" } }, "premium")).toThrow(
        EnlittConfigurationError
      );
    });

    it("rejects a function price without maxCharge but accepts it with one", () => {
      const price = () => "1";
      expect(() => readEnlittCallOptions({ enlitt: { price } as never }, "premium")).toThrow(EnlittConfigurationError);
      const ok = readEnlittCallOptions({ enlitt: { price, maxCharge: "10" } as never }, "premium");
      expect(ok.price).toBe(price);
    });

    it("rejects a non-canonical price", () => {
      expect(() => readEnlittCallOptions({ enlitt: { maxCharge: "10", price: "1.5" } }, "premium")).toThrow(
        EnlittConfigurationError
      );
    });
  });

  describe("reportingDeadlineMs", () => {
    it("is accepted only in premium and validated as a positive safe integer", () => {
      const result = readEnlittCallOptions(
        { enlitt: { maxCharge: "100", reportingDeadlineMs: 30_000 } },
        "premium"
      );
      expect(result.reportingDeadlineMs).toBe(30_000);
    });

    it("is rejected in standard mode", () => {
      expect(() => readEnlittCallOptions({ enlitt: { reportingDeadlineMs: 30_000 } }, "standard")).toThrow(
        EnlittConfigurationError
      );
    });

    it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])(
      "rejects a non-positive-safe-integer value %s",
      (value) => {
        expect(() =>
          readEnlittCallOptions(
            { enlitt: { maxCharge: "100", reportingDeadlineMs: value } },
            "premium"
          )
        ).toThrow(EnlittConfigurationError);
      }
    );

    it("has no local maximum: an unusually large but safe integer is accepted locally", () => {
      const result = readEnlittCallOptions(
        {
          enlitt: {
            maxCharge: "100",
            reportingDeadlineMs: Number.MAX_SAFE_INTEGER
          }
        },
        "premium"
      );
      expect(result.reportingDeadlineMs).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe("metadata", () => {
    it("enforces the identical Record<string, string> rule in both modes", () => {
      const metadata = { trace_id: "abc" };
      expect(readEnlittCallOptions({ enlitt: { metadata } }, "standard").metadata).toEqual(metadata);
      expect(
        readEnlittCallOptions({ enlitt: { maxCharge: "100", metadata } }, "premium")
          .metadata
      ).toEqual(metadata);
    });

    it("rejects more than 16 entries", () => {
      const metadata = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]));
      expect(() => readEnlittCallOptions({ enlitt: { metadata } }, "standard")).toThrow(EnlittConfigurationError);
    });

    it("rejects a key over 64 characters and a value over 512 characters", () => {
      expect(() =>
        readEnlittCallOptions({ enlitt: { metadata: { [`k${"x".repeat(64)}`]: "v" } } }, "standard")
      ).toThrow(EnlittConfigurationError);
      expect(() => readEnlittCallOptions({ enlitt: { metadata: { k: "v".repeat(513) } } }, "standard")).toThrow(
        EnlittConfigurationError
      );
    });

    it("rejects a non-string value", () => {
      expect(() => readEnlittCallOptions({ enlitt: { metadata: { k: 5 } } }, "standard")).toThrow(
        EnlittConfigurationError
      );
    });

    it('rejects a key beginning with "enlitt_"', () => {
      expect(() => readEnlittCallOptions({ enlitt: { metadata: { enlitt_reserved: "v" } } }, "standard")).toThrow(
        EnlittConfigurationError
      );
    });
  });

  describe("unknown and disallowed options", () => {
    it("rejects an unrecognized top-level enlitt option without altering other provider namespaces", () => {
      const providerOptions = { enlitt: { notARealOption: true }, otherProvider: { foo: "bar" } };
      expect(() => readEnlittCallOptions(providerOptions, "standard")).toThrow(EnlittConfigurationError);
      // The rejection must not mutate the caller's object.
      expect(providerOptions.otherProvider).toEqual({ foo: "bar" });
    });

    it.each(["user", "userId", "personalId", "email", "subject", "userToken", "sessionToken"])(
      "rejects an attempt to pass a personal-user hint (%s) through provider options",
      (key) => {
        expect(() => readEnlittCallOptions({ enlitt: { [key]: "someone@example.com" } }, "standard")).toThrow(
          EnlittConfigurationError
        );
      }
    );

    it("rejects providerOptions.enlitt that is not an object", () => {
      expect(() => readEnlittCallOptions({ enlitt: "not-an-object" as never }, "standard")).toThrow(
        EnlittConfigurationError
      );
      expect(() => readEnlittCallOptions({ enlitt: null as never }, "standard")).toThrow(EnlittConfigurationError);
    });
  });
});

// --- resolveCallId() -----------------------------------------------------

describe("resolveCallId()", () => {
  it("drives a multi-step tool loop: every invocation gets a distinct ID, and a retry of one step reuses it", () => {
    // Step 1: a single user message.
    const step1 = minimalParams();
    const id1 = resolveCallId({}, step1);

    // Step 2: the loop appended the assistant's tool call and a tool result,
    // growing the prompt — a real subsequent invocation in the loop.
    const step2 = minimalParams({
      prompt: [
        ...step1.prompt,
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "t", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "t", output: { type: "text", value: "ok" } }] }
      ]
    });
    const id2 = resolveCallId({}, step2);

    expect(id1).not.toBe(id2);

    // A retry of step 1 (identical prompt) reproduces its exact ID only when
    // the same base is supplied — the default base is fresh per invocation,
    // so retry-safety requires a caller-supplied idempotencyKey (see below).
    const retryOfStep1 = minimalParams();
    const idRetry = resolveCallId({}, retryOfStep1);
    expect(idRetry).not.toBe(id1); // no supplied key: default base is fresh every time, by design.
  });

  it("with a supplied idempotencyKey, makes the whole sequence reproducible across a re-run", () => {
    const options = { idempotencyKey: "fixed-base-00000001" };
    const step1 = minimalParams();
    const step2 = minimalParams({
      prompt: [...step1.prompt, { role: "assistant", content: [{ type: "text", text: "ok" }] }]
    });

    const run1Step1 = resolveCallId(options, step1);
    const run1Step2 = resolveCallId(options, step2);
    const run2Step1 = resolveCallId(options, step1);
    const run2Step2 = resolveCallId(options, step2);

    expect(run1Step1).toBe(run2Step1);
    expect(run1Step2).toBe(run2Step2);
    expect(run1Step1).not.toBe(run1Step2);
  });

  it("produces a fresh, unique base per invocation when idempotencyKey is omitted", () => {
    const params = minimalParams();
    const ids = new Set(Array.from({ length: 20 }, () => resolveCallId({}, params)));
    expect(ids.size).toBe(20);
  });

  it("every produced ID satisfies the protocol's 16-255 visible-ASCII Idempotency-Key bound", () => {
    const params = minimalParams();
    const defaultId = resolveCallId({}, params);
    expect(defaultId.length).toBeGreaterThanOrEqual(IDEMPOTENCY_KEY_MIN_LENGTH);
    expect(defaultId.length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_MAX_LENGTH);
    expect(/^[\x21-\x7e]+$/.test(defaultId)).toBe(true);

    const suppliedId = resolveCallId({ idempotencyKey: "x".repeat(30) }, params);
    expect(suppliedId.length).toBeGreaterThanOrEqual(IDEMPOTENCY_KEY_MIN_LENGTH);
    expect(suppliedId.length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_MAX_LENGTH);
  });

  it("does not read prompt, file, tool, or output content: differing content with an identical item count yields the identical ID under a supplied key", () => {
    const options = { idempotencyKey: "fixed-base-00000002" };
    const paramsA = minimalParams({ prompt: [{ role: "user", content: [{ type: "text", text: "hello world" }] }] });
    const paramsB = minimalParams({
      prompt: [{ role: "user", content: [{ type: "text", text: "an entirely different message" }] }]
    });
    expect(resolveCallId(options, paramsA)).toBe(resolveCallId(options, paramsB));
  });
});
