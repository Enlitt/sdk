/**
 * Premium for non-language Vercel models: image generation, text-to-speech, and
 * speech-to-text (owner decision 2026-11-15).
 *
 * An image, speech, or transcription call is one provider `doGenerate()`, so it
 * is the language wrapper's non-streaming path with a different result shape.
 * This file reuses `readEnlittCallOptions()`, `runPremiumCharge()`, the shared
 * price evaluation, and the core's clamp exactly. What it adds is only:
 *
 * - the call identity (the supplied `idempotencyKey` itself, or a fresh random
 *   ID; a media call has no growing prompt to count),
 * - the per-kind price context, and
 * - the result mapping (images untouched; speech and transcription gain
 *   `providerMetadata.enlitt`).
 *
 * The begin and terminal requests are byte for byte the language wrapper's:
 * there is no modality field on the wire. Nothing about the call's content
 * (prompt, text, audio, images) is ever sent to Enlitt; the price context
 * lives and dies in the business's own process.
 */

import type {
  ImageModelV3,
  ImageModelV3CallOptions,
  SpeechModelV3,
  SpeechModelV3CallOptions,
  TranscriptionModelV3,
  TranscriptionModelV3CallOptions
} from "@ai-sdk/provider";
import { EnlittConfigurationError } from "../core/errors.js";
import {
  assertCallId,
  assertNanoUsd,
  generateRandomCallId,
  isCancellation,
  runPremiumCharge,
  type PremiumChargeHandle,
  type PremiumChargeRequest,
  type PremiumTerminalFacts
} from "../core/premium.js";
import type { InternalEnlittClient } from "../core/transport.js";
import { readEnlittCallOptions } from "./language-model.js";
import { evaluatePrice, timingFacts } from "./premium-language-model.js";

// --- Public types ------------------------------------------------------------

/** What an image model's `doGenerate()` resolves with, derived rather than invented. */
export type ImageGenerateResult = Awaited<ReturnType<ImageModelV3["doGenerate"]>>;
/** What a speech model's `doGenerate()` resolves with. */
export type SpeechGenerateResult = Awaited<ReturnType<SpeechModelV3["doGenerate"]>>;
/** What a transcription model's `doGenerate()` resolves with. */
export type TranscriptionGenerateResult = Awaited<ReturnType<TranscriptionModelV3["doGenerate"]>>;

/** The fields every media price context shares. */
export interface PremiumMediaPriceBase {
  readonly status: "completed" | "canceled";
  /** When the provider was invoked. */
  readonly startedAt: Date;
  /** When the provider resolved, or when the call was canceled. */
  readonly endedAt: Date;
  readonly durationMs: number;
  /** The most this call can charge; any price above it is lowered to it. */
  readonly effectiveMaxChargeNanoUsd: string;
}

/**
 * Everything the SDK knows when a media call ends, discriminated by `kind`.
 * `result` is the provider's own result on `completed` and absent on
 * `canceled`. `request` holds only a few facts read from the call options.
 */
export type PremiumMediaPriceContext =
  | (PremiumMediaPriceBase & {
      readonly kind: "image";
      readonly request: { readonly n: number; readonly size?: string; readonly aspectRatio?: string };
      readonly result?: ImageGenerateResult;
    })
  | (PremiumMediaPriceBase & {
      readonly kind: "speech";
      /** `characters` is the number of Unicode code points in the text to speak. */
      readonly request: { readonly characters: number; readonly voice?: string; readonly outputFormat?: string };
      readonly result?: SpeechGenerateResult;
    })
  | (PremiumMediaPriceBase & {
      readonly kind: "transcription";
      readonly request: { readonly mediaType: string };
      readonly result?: TranscriptionGenerateResult;
    });

/**
 * What a premium media call states it costs. Same rules as `EnlittPrice`: a
 * constant is charged on `completed` and `canceled`; a function runs once on
 * either, may be async, and is never called on `failed`.
 */
export type EnlittMediaPrice = string | ((context: PremiumMediaPriceContext) => string | Promise<string>);

/** Any of the three media model interfaces the wrapper accepts. */
export type PremiumMediaModel = ImageModelV3 | SpeechModelV3 | TranscriptionModelV3;

// --- The wrapper ---------------------------------------------------------------

/**
 * Wraps an image model (`kind: "image"`), or a speech or transcription model
 * (`kind: "audio"`), with the premium billing lifecycle.
 *
 * Returns a new object carrying the wrapped model's `specificationVersion`,
 * `provider`, and `modelId`, plus an image model's `maxImagesPerCall` forwarded
 * by reference (a function stays a function, called with the wrapped model as
 * `this`). Only `doGenerate` is replaced. The provider is never invoked before
 * Enlitt admits the call: every session and refusal path is
 * `runPremiumCharge()`'s.
 *
 * Speech and transcription models have the same structural shape, so for
 * `kind: "audio"` each call decides which it is from its own options.
 */
export function createPremiumMediaModel(
  client: InternalEnlittClient,
  model: ImageModelV3,
  kind: "image"
): ImageModelV3;
export function createPremiumMediaModel(
  client: InternalEnlittClient,
  model: SpeechModelV3 | TranscriptionModelV3,
  kind: "audio"
): SpeechModelV3 | TranscriptionModelV3;
export function createPremiumMediaModel(
  client: InternalEnlittClient,
  model: PremiumMediaModel,
  kind: "image" | "audio"
): PremiumMediaModel {
  const labels = { id: model.provider, model: model.modelId };

  if (kind === "image") {
    const image = model as ImageModelV3;
    const maxImagesPerCall = image.maxImagesPerCall;
    const wrapped: ImageModelV3 = {
      specificationVersion: "v3",
      provider: image.provider,
      modelId: image.modelId,
      // Forwarded by reference. A function is bound so that a provider
      // implementation reading `this` still sees its own model.
      maxImagesPerCall:
        typeof maxImagesPerCall === "function" ? maxImagesPerCall.bind(image) : maxImagesPerCall,
      doGenerate: (options: ImageModelV3CallOptions) =>
        runMediaCall(client, labels, options.providerOptions, options.abortSignal, {
          kind: "image",
          request: {
            n: options.n,
            ...(options.size !== undefined ? { size: options.size } : {}),
            ...(options.aspectRatio !== undefined ? { aspectRatio: options.aspectRatio } : {})
          },
          invoke: () => Promise.resolve(image.doGenerate(options)),
          // `generateImage` keeps only an `images` array from each
          // `providerMetadata` namespace, so an `enlitt` namespace would be
          // dropped and, lacking `images`, would break its merge. The image
          // result is therefore returned by identity.
          mapResult: (result) => result,
          facts: (result) => imageUsageFacts(result)
        })
    };
    return wrapped;
  }

  // Speech and transcription share every member but `doGenerate`'s options,
  // so the wrapper accepts either and decides per call.
  const audio = model as SpeechModelV3 & TranscriptionModelV3;
  const wrapped = {
    specificationVersion: "v3" as const,
    provider: audio.provider,
    modelId: audio.modelId,
    doGenerate(options: SpeechModelV3CallOptions | TranscriptionModelV3CallOptions) {
      if (isSpeechOptions(options)) {
        return runMediaCall(client, labels, options.providerOptions, options.abortSignal, {
          kind: "speech",
          request: {
            characters: [...options.text].length,
            ...(options.voice !== undefined ? { voice: options.voice } : {}),
            ...(options.outputFormat !== undefined ? { outputFormat: options.outputFormat } : {})
          },
          invoke: () => Promise.resolve((audio as SpeechModelV3).doGenerate(options)),
          mapResult: attachEnlittMetadata,
          facts: () => ({})
        });
      }
      if (isTranscriptionOptions(options)) {
        return runMediaCall(client, labels, options.providerOptions, options.abortSignal, {
          kind: "transcription",
          request: { mediaType: options.mediaType },
          invoke: () => Promise.resolve((audio as TranscriptionModelV3).doGenerate(options)),
          mapResult: attachEnlittMetadata,
          facts: () => ({})
        });
      }
      return Promise.reject(
        new EnlittConfigurationError(
          "A premium audio call needs either a string `text` (speech) or `audio` with a string `mediaType` (transcription)."
        )
      );
    }
  };
  return wrapped as SpeechModelV3 | TranscriptionModelV3;
}

/** Speech call options carry the text to speak. */
function isSpeechOptions(options: object): options is SpeechModelV3CallOptions {
  return typeof (options as { text?: unknown }).text === "string";
}

/** Transcription call options carry audio (base64 string or bytes) and its media type. */
function isTranscriptionOptions(options: object): options is TranscriptionModelV3CallOptions {
  const audio = (options as { audio?: unknown }).audio;
  return (
    (typeof audio === "string" || audio instanceof Uint8Array) &&
    typeof (options as { mediaType?: unknown }).mediaType === "string"
  );
}

// --- One media call ------------------------------------------------------------

/**
 * The per-kind pieces `runMediaCall` needs. `Kind` and `Result` tie the
 * request facts, the provider call, and the result mapping to one media kind
 * so the price context is always internally consistent.
 */
type MediaCallSpec<Result> =
  | {
      readonly kind: "image";
      readonly request: Extract<PremiumMediaPriceContext, { kind: "image" }>["request"];
      readonly invoke: () => Promise<Result>;
      readonly mapResult: (result: Result, operation: PremiumChargeHandle) => Result;
      readonly facts: (result: Result) => Pick<PremiumTerminalFacts, "usage">;
    }
  | {
      readonly kind: "speech";
      readonly request: Extract<PremiumMediaPriceContext, { kind: "speech" }>["request"];
      readonly invoke: () => Promise<Result>;
      readonly mapResult: (result: Result, operation: PremiumChargeHandle) => Result;
      readonly facts: (result: Result) => Pick<PremiumTerminalFacts, "usage">;
    }
  | {
      readonly kind: "transcription";
      readonly request: Extract<PremiumMediaPriceContext, { kind: "transcription" }>["request"];
      readonly invoke: () => Promise<Result>;
      readonly mapResult: (result: Result, operation: PremiumChargeHandle) => Result;
      readonly facts: (result: Result) => Pick<PremiumTerminalFacts, "usage">;
    };

/**
 * Runs one media provider call inside `runPremiumCharge()`.
 *
 * - Options are read with the language wrapper's own `readEnlittCallOptions()`;
 *   every failure is an `EnlittConfigurationError` before any request.
 * - A resolved call is `completed`: the price is evaluated with the provider's
 *   result and the safe facts are recorded.
 * - A rejection while canceled evaluates the price with no result, then
 *   rethrows unchanged; the core reports `canceled`.
 * - Any other rejection is rethrown unchanged without calling the price; the
 *   core reports `failed` at `"0"`.
 */
async function runMediaCall<Result>(
  client: InternalEnlittClient,
  labels: { id: string; model: string },
  providerOptions: Parameters<typeof readEnlittCallOptions>[0],
  signal: AbortSignal | undefined,
  spec: MediaCallSpec<Result>
): Promise<Result> {
  const options = readEnlittCallOptions(providerOptions, "premium");
  const price = options.price as EnlittMediaPrice | undefined;
  const request: PremiumChargeRequest = {
    // Always present for a premium call: `readEnlittCallOptions` resolves it
    // from the declared value or a constant price.
    maxCharge: options.maxCharge!,
    provider: labels,
    // One media call is one provider invocation, so a supplied key is the
    // call ID itself (the OpenAI adapter's rule), and otherwise a fresh one.
    callId: assertCallId(options.idempotencyKey ?? generateRandomCallId()),
    ...(options.reportingDeadlineMs !== undefined ? { reportingDeadlineMs: options.reportingDeadlineMs } : {}),
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    ...(signal !== undefined ? { signal } : {})
  };

  return runPremiumCharge(client, request, async (charge, operation) => {
    const startedAt = new Date();
    let result: Result;
    try {
      result = await spec.invoke();
    } catch (thrown) {
      const endedAt = new Date();
      if (isCancellation(thrown, signal)) {
        charge(
          await evaluatePrice(client, price, buildContext(spec, "canceled", undefined, startedAt, endedAt, operation))
        );
        operation.describe({
          timing: timingFacts(startedAt, endedAt),
          delivery: { outputStarted: false, outputCompleted: false },
          errorCategory: "canceled"
        });
      } else {
        operation.describe({
          timing: timingFacts(startedAt, endedAt),
          delivery: { outputStarted: false, outputCompleted: false },
          errorCategory: "provider"
        });
      }
      // Rethrown completely unchanged: a provider's own error never becomes an
      // `EnlittError`.
      throw thrown;
    }

    const endedAt = new Date();
    charge(await evaluatePrice(client, price, buildContext(spec, "completed", result, startedAt, endedAt, operation)));
    operation.describe({
      timing: timingFacts(startedAt, endedAt),
      delivery: { outputStarted: true, outputCompleted: true },
      ...spec.facts(result)
    });
    return spec.mapResult(result, operation);
  });
}

/** Assembles the price context for one media call. */
function buildContext<Result>(
  spec: MediaCallSpec<Result>,
  status: "completed" | "canceled",
  result: Result | undefined,
  startedAt: Date,
  endedAt: Date,
  operation: PremiumChargeHandle
): PremiumMediaPriceContext {
  const base: PremiumMediaPriceBase = {
    status,
    startedAt,
    endedAt,
    durationMs: endedAt.getTime() - startedAt.getTime(),
    effectiveMaxChargeNanoUsd: operation.effectiveMaxChargeNanoUsd
  };
  // The cast is sound: `spec.kind` fixes which provider result `Result` is.
  return {
    ...base,
    kind: spec.kind,
    request: spec.request,
    ...(result !== undefined ? { result } : {})
  } as PremiumMediaPriceContext;
}

/** An image result's token usage for the terminal report, when the provider gave any. */
function imageUsageFacts(result: ImageGenerateResult): Pick<PremiumTerminalFacts, "usage"> {
  const usage = result.usage;
  if (usage === undefined) return {};
  const counts: NonNullable<PremiumTerminalFacts["usage"]> = {
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {})
  };
  return Object.keys(counts).length > 0 ? { usage: counts } : {};
}

/**
 * Returns a shallow copy of a speech or transcription result whose
 * `providerMetadata` adds `enlitt: { operationId, effectiveMaxChargeNanoUsd }`
 * beside the provider's own namespaces, exactly as the language wrapper does.
 */
function attachEnlittMetadata<Result>(result: Result, operation: PremiumChargeHandle): Result {
  const withMetadata = result as Result & { providerMetadata?: Record<string, unknown> };
  return {
    ...withMetadata,
    providerMetadata: {
      ...withMetadata.providerMetadata,
      enlitt: {
        operationId: operation.operationId,
        effectiveMaxChargeNanoUsd: operation.effectiveMaxChargeNanoUsd
      }
    }
  };
}

// --- Price helpers ---------------------------------------------------------------

/**
 * Narrows a context to one kind, throwing `EnlittConfigurationError` otherwise.
 * The price rules turn that throw into a `"0"` charge reported to
 * `onTerminalReportError`, so a helper attached to the wrong model is visible.
 */
function expectKind<K extends PremiumMediaPriceContext["kind"]>(
  context: PremiumMediaPriceContext,
  kind: K,
  helper: string
): Extract<PremiumMediaPriceContext, { kind: K }> {
  if (context.kind !== kind) {
    throw new EnlittConfigurationError(`${helper}() prices ${kind} calls, but this call is ${context.kind}.`);
  }
  return context as Extract<PremiumMediaPriceContext, { kind: K }>;
}

/**
 * Price function charging `rate` NANOUSD per generated image
 * (`rate x result.images.length`, exact `bigint`). A call with no result
 * (canceled) charges `"0"`.
 */
export function perImage(rate: string): (context: PremiumMediaPriceContext) => string {
  const perUnit = BigInt(assertNanoUsd(rate, "perImage rate"));
  return (context) => {
    const image = expectKind(context, "image", "perImage");
    return (perUnit * BigInt(image.result?.images.length ?? 0)).toString();
  };
}

/**
 * Price function charging `rate` NANOUSD per Unicode code point of the text a
 * speech call spoke. A canceled call charges `"0"`.
 */
export function perCharacter(rate: string): (context: PremiumMediaPriceContext) => string {
  const perUnit = BigInt(assertNanoUsd(rate, "perCharacter rate"));
  return (context) => {
    const speech = expectKind(context, "speech", "perCharacter");
    if (speech.status !== "completed") return "0";
    return (perUnit * BigInt(speech.request.characters)).toString();
  };
}

/**
 * Price function charging `rate` NANOUSD per started second of transcribed
 * audio (`rate x ceil(result.durationInSeconds)`). An absent duration or a
 * canceled call charges `"0"`.
 */
export function perAudioSecond(rate: string): (context: PremiumMediaPriceContext) => string {
  const perUnit = BigInt(assertNanoUsd(rate, "perAudioSecond rate"));
  return (context) => {
    const transcription = expectKind(context, "transcription", "perAudioSecond");
    const seconds = transcription.status === "completed" ? transcription.result?.durationInSeconds : undefined;
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "0";
    return (perUnit * BigInt(Math.ceil(seconds))).toString();
  };
}
