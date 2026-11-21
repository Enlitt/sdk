import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type OpenAI from "openai";
import { EnlittConfigurationError } from "../core/errors.js";
import { ENLITT_STANDARD_MODEL, enlitt } from "./client.js";
import * as openaiEntry from "./index.js";
import type { OpenAIPremiumMediaPriceContext } from "./media.js";

// The OpenAI adapter's premium image, speech, and transcription methods
// (specs/SDK-side routing.md "openai/media.ts"). Only `fetch` and the OpenAI
// client are fakes; Enlitt's request building runs for real.

// The SDK ships no media price helpers (owner decision 2026-11-20), so these
// are written here the way a business would write its own price functions.
// Each returns a NANOUSD string from the price context the SDK passes in.
const pricePerImage = (rate: bigint) => (context: OpenAIPremiumMediaPriceContext): string =>
  context.kind === "image" ? (rate * BigInt(context.response?.data?.length ?? 0)).toString() : "0";
const pricePerCharacter = (rate: bigint) => (context: OpenAIPremiumMediaPriceContext): string =>
  context.kind === "speech" && context.status === "completed" ? (rate * BigInt(context.characters)).toString() : "0";
const pricePerSecond = (rate: bigint) => (context: OpenAIPremiumMediaPriceContext): string => {
  if (context.kind !== "transcription" || typeof context.response !== "object") return "0";
  const usage = (context.response as { usage?: { type?: string; seconds?: number } }).usage;
  return usage?.type === "duration" && usage.seconds !== undefined
    ? (rate * BigInt(Math.ceil(usage.seconds))).toString()
    : "0";
};

const BASE_URL = "https://api.enlitt.test";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function admitted(effectiveMax = "1000"): Response {
  return json(200, {
    operation_id: "op_1",
    billing: "managed",
    report_terminal: true,
    effective_max_charge_nano_usd: effectiveMax,
    reserved_nano_usd: effectiveMax,
    terminal_deadline: "2026-10-05T00:00:00Z"
  });
}

function settled(): Response {
  return json(200, {
    operation_id: "op_1",
    status: "completed",
    idempotent_replay: false,
    settlement: { captured_nano_usd: "0", released_nano_usd: "0", business_earnings_nano_usd: "0" }
  });
}

/** Typed so async implementations satisfy `no-misused-promises`. */
let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
let reportErrors: unknown[];

function enlittServer(effectiveMax = "1000"): void {
  fetchMock.mockImplementation(async (url: string) => (String(url).endsWith("/terminal") ? settled() : admitted(effectiveMax)));
}

function bodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls.map((call) => JSON.parse((call[1]!).body as string) as Record<string, unknown>);
}

function terminal(): Record<string, unknown> {
  return bodies().find((body) => "report_id" in body)!;
}

const options = () => ({
  secretKey: "sk_test_1234567890",
  baseUrl: BASE_URL,
  session: { token: "session-token-123" },
  onTerminalReportError: (error: unknown) => reportErrors.push(error)
});

/** A fake OpenAI client exposing the three media methods and `responses.create`. */
function fakeOpenAI() {
  const speechResponse = new Response(new Uint8Array([1, 2, 3]));
  const openai = {
    responses: { create: vi.fn() },
    images: {
      generate: vi.fn(async (body: { n?: number }) => ({
        created: 1,
        data: Array.from({ length: body.n ?? 1 }, () => ({ b64_json: "c2VjcmV0" })),
        usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10, input_tokens_details: { image_tokens: 0, text_tokens: 4 } }
      }))
    },
    audio: {
      speech: { create: vi.fn(async () => speechResponse) },
      transcriptions: {
        create: vi.fn(async () => ({ text: "secret transcript", usage: { type: "duration", seconds: 4.5 } }))
      }
    }
  };
  return { openai, speechResponse };
}

beforeEach(() => {
  fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  reportErrors = [];
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("images.generate", () => {
  it("admits before the provider, strips enlitt, labels the model, and settles with the price function", async () => {
    enlittServer();
    const { openai } = fakeOpenAI();
    const client = enlitt(openai as unknown as OpenAI, options());
    const result = await client.images.generate({
      model: "gpt-image-1",
      prompt: "a secret cat",
      n: 2,
      enlitt: { maxCharge: "500", price: pricePerImage(40n) }
    });
    expect(result.data).toHaveLength(2);
    expect(openai.images.generate).toHaveBeenCalledWith({ model: "gpt-image-1", prompt: "a secret cat", n: 2 }, undefined);
    const [begin] = bodies();
    expect(begin).toMatchObject({ mode: "premium", max_charge_nano_usd: "500", provider: { id: "openai", model: "gpt-image-1" } });
    expect(terminal()).toMatchObject({ status: "completed", charge_nano_usd: "80", usage: { input_tokens: 4, output_tokens: 6 } });
    const serialized = JSON.stringify(bodies());
    expect(serialized).not.toContain("secret cat");
    expect(serialized).not.toContain("c2VjcmV0");
  });

  it("refuses a missing model, streaming, the standard model, and a standard-only client before any request", async () => {
    const { openai } = fakeOpenAI();
    const client = enlitt(openai as unknown as OpenAI, options());
    await expect(client.images.generate({ prompt: "x", enlitt: { maxCharge: "1" } } as never)).rejects.toBeInstanceOf(EnlittConfigurationError);
    await expect(
      client.images.generate({ model: "gpt-image-1", prompt: "x", stream: true, enlitt: { maxCharge: "1" } } as never)
    ).rejects.toBeInstanceOf(EnlittConfigurationError);
    await expect(
      client.images.generate({ model: ENLITT_STANDARD_MODEL, prompt: "x", enlitt: { maxCharge: "1" } })
    ).rejects.toBeInstanceOf(EnlittConfigurationError);
    const standardOnly = enlitt(options());
    await expect(
      standardOnly.images.generate({ model: "gpt-image-1", prompt: "x", enlitt: { maxCharge: "1" } })
    ).rejects.toBeInstanceOf(EnlittConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openai.images.generate).not.toHaveBeenCalled();
  });

  it("reports failed at zero and rethrows the provider error by identity", async () => {
    enlittServer();
    const { openai } = fakeOpenAI();
    const providerError = new Error("boom");
    openai.images.generate.mockRejectedValueOnce(providerError);
    const price = vi.fn(() => "5");
    const client = enlitt(openai as unknown as OpenAI, options());
    await expect(
      client.images.generate({ model: "gpt-image-1", prompt: "x", enlitt: { maxCharge: "10", price } })
    ).rejects.toBe(providerError);
    expect(price).not.toHaveBeenCalled();
    expect(terminal()).toMatchObject({ status: "failed", charge_nano_usd: "0" });
  });

  it("reports canceled when the signal aborted, evaluating the price without a response", async () => {
    enlittServer();
    const { openai } = fakeOpenAI();
    const controller = new AbortController();
    const abortError = new Error("Request was aborted.");
    openai.images.generate.mockImplementationOnce(async () => {
      controller.abort();
      throw abortError;
    });
    const price = vi.fn((context: OpenAIPremiumMediaPriceContext) => (context.kind === "image" && context.response === undefined ? "3" : "9"));
    const client = enlitt(openai as unknown as OpenAI, options());
    await expect(
      client.images.generate({ model: "gpt-image-1", prompt: "x", enlitt: { maxCharge: "10", price } }, { signal: controller.signal })
    ).rejects.toBe(abortError);
    expect(terminal()).toMatchObject({ status: "canceled", charge_nano_usd: "3" });
  });

  it("uses a supplied idempotencyKey as the call ID", async () => {
    enlittServer();
    const { openai } = fakeOpenAI();
    const client = enlitt(openai as unknown as OpenAI, options());
    await client.images.generate({ model: "gpt-image-1", prompt: "x", enlitt: { maxCharge: "1", idempotencyKey: "image-key-0123456789" } });
    expect(new Headers((fetchMock.mock.calls[0]![1]!).headers).get("idempotency-key")).toBe("image-key-0123456789");
  });
});

describe("audio.speech.create", () => {
  it("returns the provider Response by identity, unread, and prices code points of input", async () => {
    enlittServer();
    const { openai, speechResponse } = fakeOpenAI();
    const client = enlitt(openai as unknown as OpenAI, options());
    const result = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      input: "hé 🙂",
      voice: "alloy",
      enlitt: { maxCharge: "100", price: pricePerCharacter(5n) }
    });
    expect(result).toBe(speechResponse);
    expect(result.bodyUsed).toBe(false);
    // "hé 🙂" is 4 code points.
    expect(terminal()).toMatchObject({ status: "completed", charge_nano_usd: "20" });
    expect(JSON.stringify(bodies())).not.toContain("hé");
  });
});

describe("audio.transcriptions.create", () => {
  it("returns the transcription and prices started seconds from usage", async () => {
    enlittServer();
    const { openai } = fakeOpenAI();
    const client = enlitt(openai as unknown as OpenAI, options());
    const result = await client.audio.transcriptions.create({
      model: "gpt-4o-transcribe",
      file: new File([new Uint8Array([1])], "a.wav"),
      enlitt: { maxCharge: "1000", price: pricePerSecond(100n) }
    });
    expect(result).toMatchObject({ text: "secret transcript" });
    expect(terminal()).toMatchObject({ status: "completed", charge_nano_usd: "500" });
    expect(JSON.stringify(bodies())).not.toContain("secret transcript");
  });

  it("refuses streaming before any request", async () => {
    const { openai } = fakeOpenAI();
    const client = enlitt(openai as unknown as OpenAI, options());
    await expect(
      client.audio.transcriptions.create({ model: "whisper-1", file: new File([], "a.wav"), stream: true, enlitt: { maxCharge: "1" } } as never)
    ).rejects.toBeInstanceOf(EnlittConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("OpenAI media pricing", () => {
  it("exports no media price helpers", () => {
    for (const name of ["perImage", "perCharacter", "perAudioSecond"]) {
      expect(Object.keys(openaiEntry), name).not.toContain(name);
    }
  });

  it("a price function that throws charges zero and reaches onTerminalReportError", async () => {
    enlittServer();
    const { openai } = fakeOpenAI();
    const client = enlitt(openai as unknown as OpenAI, options());
    const throwingPrice = (): string => {
      throw new Error("business pricing bug");
    };
    await client.audio.speech.create({ model: "tts-1", input: "abc", voice: "alloy", enlitt: { maxCharge: "100", price: throwingPrice } });
    expect(terminal()).toMatchObject({ status: "completed", charge_nano_usd: "0" });
    expect(reportErrors[0]).toBeInstanceOf(EnlittConfigurationError);
  });
});
