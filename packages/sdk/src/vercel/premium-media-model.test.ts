import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ImageModelV3, SpeechModelV3, TranscriptionModelV3 } from "@ai-sdk/provider";
import { experimental_generateSpeech, experimental_transcribe, generateImage } from "ai";
import { EnlittConfigurationError } from "../core/errors.js";
import { createInternalClient } from "../core/transport.js";
import { enlitt } from "./language-model.js";
import * as vercelEntry from "./index.js";
import { createPremiumMediaModel, type PremiumMediaPriceContext } from "./premium-media-model.js";

// Premium image, speech, and transcription through the Vercel adapter
// (specs/SDK-side routing.md "vercel/premium-media-model.ts"). Only `fetch` and
// the wrapped provider models are fakes; Enlitt's request building runs for real.

// The SDK ships no media price helpers (owner decision 2026-11-20), so these
// are written here the way a business would write its own price functions.
const pricePerImage = (rate: bigint) => (context: PremiumMediaPriceContext): string =>
  context.kind === "image" ? (rate * BigInt(context.result?.images.length ?? 0)).toString() : "0";
const pricePerCharacter = (rate: bigint) => (context: PremiumMediaPriceContext): string =>
  context.kind === "speech" && context.status === "completed" ? (rate * BigInt(context.request.characters)).toString() : "0";
const pricePerSecond = (rate: bigint) => (context: PremiumMediaPriceContext): string => {
  const seconds = context.kind === "transcription" ? context.result?.durationInSeconds : undefined;
  return seconds !== undefined && seconds > 0 ? (rate * BigInt(Math.ceil(seconds))).toString() : "0";
};

const BASE_URL = "https://api.enlitt.test";
const SECRET = "sk_test_1234567890";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function admitted(effectiveMax = "1000", operationId = "op_1"): Response {
  return jsonResponse(200, {
    operation_id: operationId,
    billing: "managed",
    report_terminal: true,
    effective_max_charge_nano_usd: effectiveMax,
    reserved_nano_usd: effectiveMax,
    terminal_deadline: "2026-09-29T12:00:00Z"
  });
}

function settled(): Response {
  return jsonResponse(200, {
    operation_id: "op_1",
    status: "completed",
    idempotent_replay: false,
    settlement: { captured_nano_usd: "0", released_nano_usd: "0", business_earnings_nano_usd: "0" }
  });
}

function refused(): Response {
  return jsonResponse(403, {
    error: { message: "Refused.", type: "insufficient_credits_error", param: null, code: "subscription_inactive" }
  });
}

/** Answers every begin with an admission and every terminal report with a settlement. */
function enlittServer(effectiveMax = "1000"): void {
  let next = 0;
  fetchMock.mockImplementation(async (url: string) =>
    String(url).endsWith("/terminal") ? settled() : admitted(effectiveMax, `op_${++next}`)
  );
}

function imageModel(overrides: Partial<ImageModelV3> = {}): ImageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "openai.image",
    modelId: "gpt-image-1",
    maxImagesPerCall: 2,
    doGenerate: vi.fn(async (options) => ({
      images: Array.from({ length: options.n }, () => "aGVsbG8="),
      warnings: [],
      providerMetadata: { "openai.image": { images: Array.from({ length: options.n }, () => ({})) } },
      response: { timestamp: new Date(), modelId: "gpt-image-1", headers: undefined },
      usage: { inputTokens: 7, outputTokens: 9, totalTokens: 16 }
    })),
    ...overrides
  };
}

function speechModel(overrides: Partial<SpeechModelV3> = {}): SpeechModelV3 {
  return {
    specificationVersion: "v3",
    provider: "openai.speech",
    modelId: "tts-1",
    doGenerate: vi.fn(async () => ({
      audio: new Uint8Array([1, 2, 3]),
      warnings: [],
      response: { timestamp: new Date(), modelId: "tts-1" },
      providerMetadata: { openai: { voiceUsed: "alloy" } }
    })),
    ...overrides
  };
}

function transcriptionModel(overrides: Partial<TranscriptionModelV3> = {}): TranscriptionModelV3 {
  return {
    specificationVersion: "v3",
    provider: "openai.transcription",
    modelId: "whisper-1",
    doGenerate: vi.fn(async () => ({
      text: "secret transcript",
      segments: [],
      language: "en",
      durationInSeconds: 2.2,
      warnings: [],
      response: { timestamp: new Date(), modelId: "whisper-1" }
    })),
    ...overrides
  };
}

/** Typed so async implementations satisfy `no-misused-promises`. */
let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
let reportErrors: unknown[];

function clientOptions() {
  return {
    secretKey: SECRET,
    baseUrl: BASE_URL,
    session: { token: "session-token-123" },
    onTerminalReportError: (error: unknown) => reportErrors.push(error)
  };
}

function bodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls.map((call) => JSON.parse((call[1]!).body as string) as Record<string, unknown>);
}

function terminalBodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).endsWith("/terminal"))
    .map((call) => JSON.parse((call[1]!).body as string) as Record<string, unknown>);
}

function headersOf(index: number): Headers {
  return new Headers((fetchMock.mock.calls[index]![1]!).headers);
}

beforeEach(() => {
  fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  reportErrors = [];
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("enlitt() target recognition", () => {
  it("returns an image model with maxImagesPerCall forwarded (value and function)", () => {
    const wrapped = enlitt(imageModel(), clientOptions());
    expect(wrapped.maxImagesPerCall).toBe(2);
    expect(wrapped.provider).toBe("openai.image");
    expect(wrapped.modelId).toBe("gpt-image-1");

    const inner = imageModel({
      maxImagesPerCall(this: ImageModelV3) {
        return this.modelId === "gpt-image-1" ? 4 : 0;
      }
    });
    const withFunction = enlitt(inner, clientOptions());
    expect(typeof withFunction.maxImagesPerCall).toBe("function");
    expect((withFunction.maxImagesPerCall as (o: { modelId: string }) => number)({ modelId: "x" })).toBe(4);
  });

  it("treats a maxImagesPerCall member that is undefined as an image model", async () => {
    enlittServer();
    const wrapped = enlitt(imageModel({ maxImagesPerCall: undefined }), clientOptions());
    expect("maxImagesPerCall" in wrapped).toBe(true);
  });

  it("returns speech and transcription models without doStream", () => {
    const speech = enlitt(speechModel(), clientOptions());
    const transcription = enlitt(transcriptionModel(), clientOptions());
    expect(speech.modelId).toBe("tts-1");
    expect(transcription.modelId).toBe("whisper-1");
    expect("doStream" in speech).toBe(false);
  });

  it("refuses a v2 model and a non-model object at construction", () => {
    expect(() => enlitt({ ...speechModel(), specificationVersion: "v2" } as never, clientOptions())).toThrow(
      EnlittConfigurationError
    );
    expect(() => enlitt({ hello: "world" } as never, clientOptions())).toThrow(EnlittConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("premium image calls", () => {
  it("begins before the provider, sends no content, and settles completed with the price", async () => {
    enlittServer();
    const inner = imageModel();
    const order: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      order.push(String(url).endsWith("/terminal") ? "report" : "begin");
      return String(url).endsWith("/terminal") ? settled() : admitted();
    });
    (inner.doGenerate as Mock<ImageModelV3["doGenerate"]>).mockImplementationOnce(async (options) => {
      order.push("provider");
      return imageModel().doGenerate(options);
    });
    const model = enlitt(inner, clientOptions());

    const result = await model.doGenerate({
      prompt: "a secret cat",
      n: 2,
      size: "1024x1024",
      aspectRatio: undefined,
      seed: undefined,
      files: undefined,
      mask: undefined,
      providerOptions: { enlitt: { maxCharge: "900", price: pricePerImage(100n) as never } }
    });

    expect(order).toEqual(["begin", "provider", "report"]);
    const [begin, report] = bodies();
    expect(begin).toMatchObject({ mode: "premium", max_charge_nano_usd: "900", provider: { id: "openai.image", model: "gpt-image-1" } });
    expect(report).toMatchObject({ status: "completed", charge_nano_usd: "200", usage: { input_tokens: 7, output_tokens: 9 } });
    const serialized = JSON.stringify(bodies());
    expect(serialized).not.toContain("secret cat");
    expect(serialized).not.toContain("aGVsbG8=");
    // The image result is the provider's own object, with no enlitt namespace.
    expect(result.providerMetadata).toEqual({ "openai.image": { images: [{}, {}] } });
  });

  it("leaves the provider uninvoked when Enlitt refuses", async () => {
    fetchMock.mockResolvedValueOnce(refused());
    const inner = imageModel();
    const model = enlitt(inner, clientOptions());
    await expect(
      model.doGenerate({
        prompt: "x", n: 1, size: undefined, aspectRatio: undefined, seed: undefined, files: undefined, mask: undefined,
        providerOptions: { enlitt: { maxCharge: "10" } }
      })
    ).rejects.toMatchObject({ code: "subscription_inactive", providerInvoked: false });
    expect(inner.doGenerate).not.toHaveBeenCalled();
  });

  it("lowers a price above the effective maximum to the maximum", async () => {
    enlittServer("150");
    const model = enlitt(imageModel(), clientOptions());
    await model.doGenerate({
      prompt: "x", n: 2, size: undefined, aspectRatio: undefined, seed: undefined, files: undefined, mask: undefined,
      providerOptions: { enlitt: { maxCharge: "900", price: pricePerImage(100n) as never } }
    });
    expect(terminalBodies()[0]).toMatchObject({ status: "completed", charge_nano_usd: "150" });
  });

  it("uses a supplied idempotencyKey as the call ID unchanged, and a fresh one otherwise", async () => {
    enlittServer();
    const model = enlitt(imageModel(), clientOptions());
    const call = (enlittOptions: Record<string, unknown>) =>
      model.doGenerate({
        prompt: "x", n: 1, size: undefined, aspectRatio: undefined, seed: undefined, files: undefined, mask: undefined,
        providerOptions: { enlitt: enlittOptions as never }
      });
    await call({ maxCharge: "1", idempotencyKey: "media-key-0123456789" });
    expect(headersOf(0).get("idempotency-key")).toBe("media-key-0123456789");
    await call({ maxCharge: "1" });
    await call({ maxCharge: "1" });
    const first = headersOf(2).get("idempotency-key");
    const second = headersOf(4).get("idempotency-key");
    expect(first).not.toBe(second);
    expect(first!.length).toBeGreaterThanOrEqual(16);
  });

  it("reports canceled with the price evaluated without a result, then rethrows", async () => {
    enlittServer();
    const controller = new AbortController();
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const price = vi.fn((context: PremiumMediaPriceContext) => (context.status === "canceled" ? "5" : "99"));
    const model = enlitt(
      imageModel({
        doGenerate: vi.fn(async () => {
          controller.abort();
          throw abortError;
        })
      }),
      clientOptions()
    );
    await expect(
      model.doGenerate({
        prompt: "x", n: 1, size: undefined, aspectRatio: undefined, seed: undefined, files: undefined, mask: undefined,
        abortSignal: controller.signal,
        providerOptions: { enlitt: { maxCharge: "10", price: price as never } }
      })
    ).rejects.toBe(abortError);
    expect(price).toHaveBeenCalledOnce();
    expect(price.mock.calls[0]![0]).toMatchObject({ kind: "image", status: "canceled" });
    expect(price.mock.calls[0]![0]).not.toHaveProperty("result");
    expect(terminalBodies()[0]).toMatchObject({ status: "canceled", charge_nano_usd: "5" });
  });

  it("reports failed at zero without calling the price, and rethrows the provider error unchanged", async () => {
    enlittServer();
    const providerError = new Error("provider exploded");
    const price = vi.fn(() => "5");
    const model = enlitt(imageModel({ doGenerate: vi.fn(async () => { throw providerError; }) }), clientOptions());
    await expect(
      model.doGenerate({
        prompt: "x", n: 1, size: undefined, aspectRatio: undefined, seed: undefined, files: undefined, mask: undefined,
        providerOptions: { enlitt: { maxCharge: "10", price: price as never } }
      })
    ).rejects.toBe(providerError);
    expect(price).not.toHaveBeenCalled();
    expect(terminalBodies()[0]).toMatchObject({ status: "failed", charge_nano_usd: "0" });
  });

  it("runs end to end through generateImage, one operation per provider call when n exceeds maxImagesPerCall", async () => {
    enlittServer();
    const inner = imageModel();
    const result = await generateImage({
      model: enlitt(inner, clientOptions()),
      prompt: "three secret cats",
      n: 3,
      providerOptions: { enlitt: { maxCharge: "1000", price: pricePerImage(10n) as never } }
    });
    expect(result.images).toHaveLength(3);
    expect(inner.doGenerate).toHaveBeenCalledTimes(2);
    const reports = terminalBodies();
    expect(reports.map((r) => r.charge_nano_usd).sort()).toEqual(["10", "20"]);
    const keys = fetchMock.mock.calls
      .filter((call) => !String(call[0]).endsWith("/terminal"))
      .map((call) => new Headers((call[1]!).headers).get("idempotency-key"));
    expect(new Set(keys).size).toBe(2);
  });
});

describe("premium speech and transcription calls", () => {
  it("prices speech by code points and adds only providerMetadata.enlitt", async () => {
    enlittServer();
    const model = enlitt(speechModel(), clientOptions());
    const result = await model.doGenerate({
      text: "héllo 🙂",
      voice: "alloy",
      providerOptions: { enlitt: { maxCharge: "1000", price: pricePerCharacter(3n) as never } }
    });
    // "héllo 🙂" is 7 code points (the emoji counts once).
    expect(terminalBodies()[0]).toMatchObject({ status: "completed", charge_nano_usd: "21" });
    expect(result.providerMetadata).toEqual({
      openai: { voiceUsed: "alloy" },
      enlitt: { operationId: "op_1", effectiveMaxChargeNanoUsd: "1000" }
    });
    expect(JSON.stringify(bodies())).not.toContain("héllo");
  });

  it("prices transcription by started seconds and never sends the audio or transcript", async () => {
    enlittServer();
    const model = enlitt(transcriptionModel(), clientOptions());
    const result = await model.doGenerate({
      audio: new Uint8Array([9, 9, 9]),
      mediaType: "audio/wav",
      providerOptions: { enlitt: { maxCharge: "1000", price: pricePerSecond(50n) as never } }
    });
    expect(result.text).toBe("secret transcript");
    expect(terminalBodies()[0]).toMatchObject({ status: "completed", charge_nano_usd: "150" });
    expect(JSON.stringify(bodies())).not.toContain("secret transcript");
    expect(result.providerMetadata).toEqual({ enlitt: { operationId: "op_1", effectiveMaxChargeNanoUsd: "1000" } });
  });

  it("refuses an audio call that is neither speech nor transcription before any request", async () => {
    const model = enlitt(speechModel(), clientOptions());
    await expect(model.doGenerate({ providerOptions: { enlitt: { maxCharge: "1" } } } as never)).rejects.toBeInstanceOf(
      EnlittConfigurationError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a premium media call without maxCharge before any request", async () => {
    const inner = speechModel();
    const model = enlitt(inner, clientOptions());
    await expect(model.doGenerate({ text: "hi" })).rejects.toBeInstanceOf(EnlittConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inner.doGenerate).not.toHaveBeenCalled();
  });

  it("runs end to end through experimental_generateSpeech and experimental_transcribe", async () => {
    enlittServer();
    const speech = await experimental_generateSpeech({
      model: enlitt(speechModel(), clientOptions()),
      text: "abc",
      providerOptions: { enlitt: { maxCharge: "100", price: pricePerCharacter(1n) as never } }
    });
    expect(speech.audio.uint8Array).toEqual(new Uint8Array([1, 2, 3]));
    const transcript = await experimental_transcribe({
      model: enlitt(transcriptionModel(), clientOptions()),
      audio: new Uint8Array([1, 2, 3]),
      providerOptions: { enlitt: { maxCharge: "100", price: "7" } }
    });
    expect(transcript.text).toBe("secret transcript");
    expect(terminalBodies().map((r) => r.charge_nano_usd)).toEqual(["3", "7"]);
  });
});

describe("media pricing", () => {
  it("exports no media price helpers", () => {
    for (const name of ["perImage", "perCharacter", "perAudioSecond"]) {
      expect(Object.keys(vercelEntry), name).not.toContain(name);
    }
  });

  it("passes the speech context to the business's price function and reports its amount", async () => {
    enlittServer();
    const client = createInternalClient(clientOptions());
    const model = createPremiumMediaModel(client, speechModel(), "audio");
    const seen: PremiumMediaPriceContext[] = [];
    const price = (context: PremiumMediaPriceContext): string => {
      seen.push(context);
      return "42";
    };
    await model.doGenerate({ text: "abc", providerOptions: { enlitt: { maxCharge: "100", price: price as never } } } as never);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "speech", status: "completed", request: { characters: 3 } });
    expect(terminalBodies()[0]).toMatchObject({ status: "completed", charge_nano_usd: "42" });
  });

  it("a price function that throws charges zero and reaches onTerminalReportError", async () => {
    enlittServer();
    const client = createInternalClient(clientOptions());
    const model = createPremiumMediaModel(client, speechModel(), "audio");
    const throwingPrice = (): string => {
      throw new Error("business pricing bug");
    };
    await model.doGenerate({ text: "abc", providerOptions: { enlitt: { maxCharge: "100", price: throwingPrice as never } } } as never);
    expect(terminalBodies()[0]).toMatchObject({ status: "completed", charge_nano_usd: "0" });
    expect(reportErrors[0]).toBeInstanceOf(EnlittConfigurationError);
  });
});

// Bug #28: `ai@7` and the current provider packages produce `v4` models.
describe("enlitt() with v4 models", () => {
  it("wraps v4 language, image, speech, and transcription models as v4", () => {
    const language = enlitt(
      {
        specificationVersion: "v4",
        provider: "openai.responses",
        modelId: "gpt-5-mini",
        supportedUrls: {},
        doGenerate: vi.fn(),
        doStream: vi.fn()
      } as never,
      clientOptions()
    ) as unknown as { specificationVersion: string; doStream: unknown };
    expect(language.specificationVersion).toBe("v4");
    expect(typeof language.doStream).toBe("function");

    for (const inner of [imageModel(), speechModel(), transcriptionModel()]) {
      const wrapped = enlitt({ ...inner, specificationVersion: "v4" } as never, clientOptions()) as unknown as {
        specificationVersion: string;
        modelId: string;
      };
      expect(wrapped.specificationVersion, inner.modelId).toBe("v4");
      expect(wrapped.modelId).toBe(inner.modelId);
    }
  });

  it("forwards a v4 image model's supportsFileInputs and supportsMaskInputs", () => {
    const wrapped = enlitt(
      { ...imageModel(), specificationVersion: "v4", supportsFileInputs: true, supportsMaskInputs: false } as never,
      clientOptions()
    ) as unknown as Record<string, unknown>;
    expect(wrapped.supportsFileInputs).toBe(true);
    expect(wrapped.supportsMaskInputs).toBe(false);
    // A v3 image model has neither member, and the wrapper adds none.
    expect("supportsFileInputs" in (enlitt(imageModel(), clientOptions()) as object)).toBe(false);
  });

  it("treats a v4 transcription model with doStream as media and exposes neither doStream nor doGenerateFromUrl", async () => {
    enlittServer();
    const inner = {
      ...transcriptionModel(),
      specificationVersion: "v4",
      doStream: vi.fn(),
      doGenerateFromUrl: vi.fn()
    };
    const wrapped = enlitt(inner as never, clientOptions()) as unknown as Record<string, unknown> & TranscriptionModelV3;
    expect("doStream" in wrapped).toBe(false);
    expect("doGenerateFromUrl" in wrapped).toBe(false);

    // It is still a working premium transcription model.
    await wrapped.doGenerate({
      audio: new Uint8Array([1, 2, 3]),
      mediaType: "audio/wav",
      providerOptions: { enlitt: { maxCharge: "100", price: "7" } }
    } as never);
    expect(inner.doGenerate).toHaveBeenCalledTimes(1);
    expect(inner.doStream).not.toHaveBeenCalled();
    expect(terminalBodies()[0]).toMatchObject({ status: "completed", charge_nano_usd: "7" });
  });

  it("refuses a model of a later specification (v5) at construction", () => {
    expect(() => enlitt({ ...speechModel(), specificationVersion: "v5" } as never, clientOptions())).toThrow(
      EnlittConfigurationError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
