/**
 * The OpenAI adapter's premium image, speech, and transcription methods
 * (owner decision 2026-11-15).
 *
 * Each method is one provider call inside `runPremiumCharge()`. The call-option
 * rules, price rules, clamp, status rule, and failure isolation are
 * `client.ts` premium mode's and are imported from there rather than copied;
 * this file adds only the request shapes, the operation labels, and the
 * per-kind price context.
 *
 * These methods are premium only: Enlitt has no standard image or audio model,
 * so a client built without an OpenAI instance, or a body whose `model` is
 * `ENLITT_STANDARD_MODEL`, is refused locally before admission.
 */

import { ENLITT_STANDARD_MODEL } from "@enlitt/protocol";
import type {
  ImageGenerateParamsNonStreaming,
  ImagesResponse
} from "openai/resources/images";
import type { SpeechCreateParams } from "openai/resources/audio/speech";
import type {
  TranscriptionCreateParamsNonStreaming,
  TranscriptionCreateResponse
} from "openai/resources/audio/transcriptions";
import { EnlittConfigurationError } from "../core/errors.js";
import {
  isCancellation,
  runPremiumCharge,
  type PremiumChargeHandle,
  type PremiumChargeRequest,
  type PremiumTerminalFacts
} from "../core/premium.js";
import type { InternalEnlittClient } from "../core/transport.js";
import {
  evaluatePrice,
  readCallOptions,
  validateRequestOptions,
  type EnlittOpenAICallOptions,
  type EnlittOpenAIRequestOptions
} from "./client.js";

// --- Public types ------------------------------------------------------------

/** The `enlitt` member of a media request body; the same rules as `EnlittOpenAICallOptions`. */
export interface EnlittOpenAIMediaCallOptions {
  readonly idempotencyKey?: string;
  readonly maxCharge?: string;
  readonly price?: EnlittOpenAIMediaPrice;
  readonly reportingDeadlineMs?: number;
  readonly metadata?: Record<string, string>;
}

/**
 * `images.generate()` body. `model` is required: the operation's label must
 * name the model, and the provider's default model can change.
 */
export type EnlittOpenAIImageGenerateParams = ImageGenerateParamsNonStreaming & {
  readonly model: string;
  readonly enlitt?: EnlittOpenAIMediaCallOptions;
};
/** `audio.speech.create()` body. */
export type EnlittOpenAISpeechCreateParams = SpeechCreateParams & { readonly enlitt?: EnlittOpenAIMediaCallOptions };
/** `audio.transcriptions.create()` body (non-streaming only). */
export type EnlittOpenAITranscriptionCreateParams = TranscriptionCreateParamsNonStreaming & {
  readonly enlitt?: EnlittOpenAIMediaCallOptions;
};

export interface EnlittOpenAIImages {
  generate(body: EnlittOpenAIImageGenerateParams, options?: EnlittOpenAIRequestOptions): Promise<ImagesResponse>;
}

export interface EnlittOpenAIAudio {
  readonly speech: {
    /** Resolves with the Fetch `Response` the OpenAI SDK returns; its body is the caller's to read. */
    create(body: EnlittOpenAISpeechCreateParams, options?: EnlittOpenAIRequestOptions): Promise<Response>;
  };
  readonly transcriptions: {
    create(
      body: EnlittOpenAITranscriptionCreateParams,
      options?: EnlittOpenAIRequestOptions
    ): Promise<TranscriptionCreateResponse | string>;
  };
}

/** The fields every OpenAI media price context shares. */
export interface OpenAIPremiumMediaPriceBase {
  readonly status: "completed" | "canceled";
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly durationMs: number;
  readonly effectiveMaxChargeNanoUsd: string;
}

/**
 * Everything the adapter knows when a media call ends. `request` is the body
 * without `enlitt`. A speech context carries `characters` (Unicode code points
 * of `input`) and never the `Response`, so pricing cannot consume the audio.
 */
export type OpenAIPremiumMediaPriceContext =
  | (OpenAIPremiumMediaPriceBase & {
      readonly kind: "image";
      readonly request: ImageGenerateParamsNonStreaming;
      readonly response?: ImagesResponse;
    })
  | (OpenAIPremiumMediaPriceBase & {
      readonly kind: "speech";
      readonly request: SpeechCreateParams;
      readonly characters: number;
    })
  | (OpenAIPremiumMediaPriceBase & {
      readonly kind: "transcription";
      readonly request: TranscriptionCreateParamsNonStreaming;
      readonly response?: TranscriptionCreateResponse | string;
    });

export type EnlittOpenAIMediaPrice =
  | string
  | ((context: OpenAIPremiumMediaPriceContext) => string | Promise<string>);

/**
 * The parts of the official `OpenAI` client these methods call. Checked at call
 * time, so a client lacking one of them fails only the method that needs it.
 */
export interface OpenAIMediaProvider {
  readonly images?: { generate?: (body: unknown, options?: EnlittOpenAIRequestOptions) => Promise<unknown> };
  readonly audio?: {
    readonly speech?: { create?: (body: unknown, options?: EnlittOpenAIRequestOptions) => Promise<unknown> };
    readonly transcriptions?: { create?: (body: unknown, options?: EnlittOpenAIRequestOptions) => Promise<unknown> };
  };
}

// --- Factory -------------------------------------------------------------------

/**
 * Builds the `images` and `audio` members of the client `enlitt()` returns.
 * `provider` is the OpenAI instance passed to `enlitt()`, or `undefined` for a
 * standard-only client (every media call is then refused locally).
 */
export function createMediaMethods(
  client: InternalEnlittClient,
  provider: OpenAIMediaProvider | undefined
): { images: EnlittOpenAIImages; audio: EnlittOpenAIAudio } {
  return {
    images: {
      generate: async (body, options) => {
        validateRequestOptions(options);
        assertPremiumModel(body, provider);
        if (typeof body.model !== "string" || body.model.length === 0) {
          throw new EnlittConfigurationError(
            "images.generate() through Enlitt requires a model name, so the operation names the model it paid for."
          );
        }
        if ((body as { stream?: unknown }).stream === true) {
          throw new EnlittConfigurationError("Streaming image generation is not supported through Enlitt.");
        }
        const method = requireMethod(provider?.images?.generate, "images.generate");
        const { enlitt: _removed, ...request } = body;
        return runMediaCall(client, body, options, {
          kind: "image",
          request,
          invoke: () => method.call(provider!.images, request, options) as Promise<ImagesResponse>,
          facts: imageUsageFacts
        });
      }
    },
    audio: {
      speech: {
        create: async (body, options) => {
          validateRequestOptions(options);
          assertPremiumModel(body, provider);
          const method = requireMethod(provider?.audio?.speech?.create, "audio.speech.create");
          const { enlitt: _removed, ...request } = body;
          return runMediaCall(client, body, options, {
            kind: "speech",
            request,
            characters: [...request.input].length,
            // The `Response` body is the caller's; the adapter never reads it.
            invoke: () => method.call(provider!.audio!.speech, request, options) as Promise<Response>,
            facts: () => ({})
          });
        }
      },
      transcriptions: {
        create: async (body, options) => {
          validateRequestOptions(options);
          assertPremiumModel(body, provider);
          if ((body as { stream?: unknown }).stream === true) {
            throw new EnlittConfigurationError("Streaming transcription is not supported through Enlitt.");
          }
          const method = requireMethod(provider?.audio?.transcriptions?.create, "audio.transcriptions.create");
          const { enlitt: _removed, ...request } = body;
          return runMediaCall(client, body, options, {
            kind: "transcription",
            request,
            invoke: () =>
              method.call(provider!.audio!.transcriptions, request, options) as Promise<
                TranscriptionCreateResponse | string
              >,
            facts: () => ({})
          });
        }
      }
    }
  };
}

/** Media is premium only: refuse a standard-only client and the standard model name locally. */
function assertPremiumModel(body: { model?: unknown }, provider: OpenAIMediaProvider | undefined): void {
  if (body.model === ENLITT_STANDARD_MODEL) {
    throw new EnlittConfigurationError(
      `Enlitt has no standard image or audio model; "${ENLITT_STANDARD_MODEL}" is a language model only.`
    );
  }
  if (provider === undefined) {
    throw new EnlittConfigurationError("A premium OpenAI model requires an OpenAI client passed to enlitt().");
  }
}

/** Returns the provider method, or refuses locally when the supplied client lacks it. */
function requireMethod<F extends (...args: never[]) => unknown>(method: F | undefined, name: string): F {
  if (typeof method !== "function") {
    throw new EnlittConfigurationError(`The OpenAI client passed to enlitt() does not expose ${name}().`);
  }
  return method;
}

// --- One media call ------------------------------------------------------------

/** The per-kind pieces of one media call. */
type MediaCallSpec<Result> =
  | {
      readonly kind: "image";
      readonly request: ImageGenerateParamsNonStreaming;
      readonly invoke: () => Promise<Result>;
      readonly facts: (result: Result) => Pick<PremiumTerminalFacts, "usage">;
    }
  | {
      readonly kind: "speech";
      readonly request: SpeechCreateParams;
      readonly characters: number;
      readonly invoke: () => Promise<Result>;
      readonly facts: (result: Result) => Pick<PremiumTerminalFacts, "usage">;
    }
  | {
      readonly kind: "transcription";
      readonly request: TranscriptionCreateParamsNonStreaming;
      readonly invoke: () => Promise<Result>;
      readonly facts: (result: Result) => Pick<PremiumTerminalFacts, "usage">;
    };

/**
 * Runs one provider call inside `runPremiumCharge()`. A resolved call is
 * `completed`; a rejection while `options.signal` is aborted (or an
 * `AbortError`) is `canceled` and evaluates the price with no response; any
 * other rejection is `failed` at `"0"`. The provider result or error is
 * returned or thrown by identity.
 */
async function runMediaCall<Result>(
  client: InternalEnlittClient,
  body: { model?: unknown; enlitt?: EnlittOpenAIMediaCallOptions },
  options: EnlittOpenAIRequestOptions | undefined,
  spec: MediaCallSpec<Result>
): Promise<Result> {
  // The runtime rules are identical; only the price function's context type
  // differs, so the cast is sound.
  const call = readCallOptions(body as { enlitt?: EnlittOpenAICallOptions }, "premium");
  const price = call.price as EnlittOpenAIMediaPrice | undefined;
  const signal = options?.signal;
  const request: PremiumChargeRequest = {
    maxCharge: call.maxCharge!,
    provider: { id: "openai", model: String(body.model) },
    callId: call.idempotencyKey,
    ...(call.reportingDeadlineMs !== undefined ? { reportingDeadlineMs: call.reportingDeadlineMs } : {}),
    ...(call.metadata !== undefined ? { metadata: call.metadata } : {}),
    ...(signal !== undefined ? { signal } : {})
  };

  return runPremiumCharge(client, request, async (charge, operation) => {
    const startedAt = new Date();
    let result: Result;
    try {
      result = await spec.invoke();
    } catch (thrown) {
      const endedAt = new Date();
      const canceled = isCancellation(thrown, signal);
      if (canceled) {
        charge(await evaluatePrice(client, price, buildContext(spec, "canceled", undefined, startedAt, endedAt, operation)));
      }
      operation.describe({
        timing: { startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString() },
        delivery: { outputStarted: false, outputCompleted: false },
        errorCategory: canceled ? "canceled" : "provider"
      });
      throw thrown;
    }
    const endedAt = new Date();
    charge(await evaluatePrice(client, price, buildContext(spec, "completed", result, startedAt, endedAt, operation)));
    operation.describe({
      timing: { startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString() },
      delivery: { outputStarted: true, outputCompleted: true },
      ...spec.facts(result)
    });
    return result;
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
): OpenAIPremiumMediaPriceContext {
  const base: OpenAIPremiumMediaPriceBase = {
    status,
    startedAt,
    endedAt,
    durationMs: endedAt.getTime() - startedAt.getTime(),
    effectiveMaxChargeNanoUsd: operation.effectiveMaxChargeNanoUsd
  };
  if (spec.kind === "speech") {
    return { ...base, kind: "speech", request: spec.request, characters: spec.characters };
  }
  // The cast is sound: `spec.kind` fixes which provider result `Result` is.
  return {
    ...base,
    kind: spec.kind,
    request: spec.request,
    ...(result !== undefined ? { response: result } : {})
  } as OpenAIPremiumMediaPriceContext;
}

/** An `ImagesResponse`'s token usage for the terminal report, when present. */
function imageUsageFacts(result: unknown): Pick<PremiumTerminalFacts, "usage"> {
  const usage = (result as ImagesResponse | undefined)?.usage;
  if (usage === undefined) return {};
  return { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } };
}
