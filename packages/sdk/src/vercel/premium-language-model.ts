/**
 * The Vercel AI SDK adapter over the framework-neutral premium lifecycle.
 *
 * `specs/SDK-side routing.md` gives this file only the provider mapping around
 * `core/premium.ts`: it wraps the provider model a business selected and pays
 * for, maps each provider-interface outcome onto the core's status and charge,
 * collects the price context, and offers `perToken()`. It contains no begin, no
 * status rule, no clamp, and no report of its own; all of those are
 * `runPremiumCharge()`'s, so a business moving a call between this wrapper and
 * `withPremiumCharge()` changes how the charge is computed and nothing about how
 * it is settled.
 *
 * The internal client is never null: an SDK holding no Enlitt configuration
 * fails at construction (`createInternalClient()`), before any model exists, so
 * there is no premium model that can reach a provider without Enlitt having
 * admitted the call first. A session that is absent, expired, or revoked fails
 * the call with the provider uninvoked, because letting a rejected session fall
 * through would silently move that user's spend onto the business.
 *
 * Nothing about a call's content is ever sent to Enlitt: the price context lives
 * and dies in the business's own process.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage
} from "@ai-sdk/provider";
import { EnlittConfigurationError } from "../core/errors.js";
import {
  assertNanoUsd,
  isCancellation,
  runPremiumCharge,
  type PremiumChargeRequest,
  type PremiumChargeHandle,
  type PremiumChargeFunction,
  type PremiumTerminalFacts
} from "../core/premium.js";
import type { InternalEnlittClient } from "../core/transport.js";
import {
  readEnlittCallOptions,
  resolveCallId,
  type EnlittPrice,
  type PremiumPriceContext
} from "./language-model.js";

/**
 * Derived rather than invented, per the shared type conventions: the pinned
 * package exports no name for what `doGenerate()` returns, so this alias is the
 * only place that fact is stated and it can never drift from the interface it
 * claims to implement.
 */
type GenerateResult = Awaited<ReturnType<LanguageModelV3["doGenerate"]>>;

/** Same reasoning as {@link GenerateResult}, for `doStream()`. */
type StreamResult = Awaited<ReturnType<LanguageModelV3["doStream"]>>;

// --- perToken ----------------------------------------------------------------

/**
 * Returns a price function: `input x usage.inputTokens.total + output x
 * usage.outputTokens.total`, both rates in NANOUSD per token as canonical
 * strings, computed exactly in `bigint`. A missing total counts as zero, so a
 * canceled call with no usage charges nothing for that side. Cached and
 * reasoning tokens are priced as ordinary input and output tokens, as they are
 * already inside the totals; a business that prices them differently writes its
 * own function. Non-canonical rates are rejected as `EnlittConfigurationError`
 * when the function is created, not when it runs.
 */
export function perToken(rates: { input: string; output: string }): (context: PremiumPriceContext) => string {
  const inputRate = BigInt(assertNanoUsd(rates.input, "perToken input rate"));
  const outputRate = BigInt(assertNanoUsd(rates.output, "perToken output rate"));

  return (context) => {
    const inputTokens = BigInt(context.usage?.inputTokens.total ?? 0);
    const outputTokens = BigInt(context.usage?.outputTokens.total ?? 0);
    return (inputRate * inputTokens + outputRate * outputTokens).toString();
  };
}

// --- The wrapping model --------------------------------------------------------

/**
 * Transparently wraps the business's own provider model with the premium
 * billing lifecycle.
 *
 * Preserves every request, provider option, result, warning, error, response ID,
 * and stream part `model` itself produces, adding only `providerMetadata.enlitt`
 * (`{ operationId, effectiveMaxChargeNanoUsd }` and nothing else) to the
 * non-streaming result and to a stream's `finish` part. `provider` and
 * `modelId` pass straight through, because this middleware changes nothing
 * about which provider or model identity a caller sees.
 *
 * One model invocation is one operation. A Vercel agent loop invokes the model
 * once per step, so each step has its own maximum, price, and report; an
 * automatic retry of the same step re-presents the same prompt, resolves the
 * same call ID, and replays the same operation instead of beginning a second.
 */
export function createPremiumLanguageModel(client: InternalEnlittClient, model: LanguageModelV3): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,

    doGenerate(params: LanguageModelV3CallOptions): Promise<GenerateResult> {
      return invoke(params, (request, price) =>
        wrapPremiumGenerate(client, request, price, () => Promise.resolve(model.doGenerate(params)))
      );
    },

    doStream(params: LanguageModelV3CallOptions): Promise<StreamResult> {
      return invoke(params, (request, price) =>
        wrapPremiumStream(client, request, price, () => Promise.resolve(model.doStream(params)))
      );
    }
  };

  /**
   * Reads this invocation's options and call identity, then hands the wrapper a
   * request carrying the provider labels read from the wrapped model itself.
   * Option errors are thrown synchronously inside the returned promise, before
   * any Enlitt or provider request.
   */
  async function invoke<T>(
    params: LanguageModelV3CallOptions,
    wrap: (request: PremiumChargeRequest, price: EnlittPrice | undefined) => Promise<T>
  ): Promise<T> {
    const options = readEnlittCallOptions(params.providerOptions, "premium");
    const callId = resolveCallId(options, params);
    // `maxCharge` is always present for a premium call: `readEnlittCallOptions`
    // resolves it from the declared value or a constant price.
    const request: PremiumChargeRequest = {
      maxCharge: options.maxCharge!,
      provider: { id: model.provider, model: model.modelId },
      callId,
      ...(options.reportingDeadlineMs !== undefined ? { reportingDeadlineMs: options.reportingDeadlineMs } : {}),
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
      ...(params.abortSignal !== undefined ? { signal: params.abortSignal } : {})
    };
    return wrap(request, options.price);
  }
}

// --- Price evaluation ------------------------------------------------------

/**
 * Resolves what the call charges, for a status of `completed` or `canceled`.
 *
 * - No `price`: `"0"` (a call with only `maxCharge` is free).
 * - A constant: that constant, on both statuses.
 * - A function: awaited exactly once, with no timeout of its own (a price that
 *   misses the terminal deadline only costs the business, because the call then
 *   expires and charges nothing). A throw, a rejection, or a result that is not
 *   a canonical nonnegative NANOUSD string charges `"0"` and is passed to
 *   `onTerminalReportError` as an `EnlittConfigurationError`; the call's own
 *   result or stream is unaffected.
 *
 * It never lowers the result to the effective maximum: that is the core's rule,
 * applied when it reports.
 */
async function evaluatePrice(
  client: InternalEnlittClient,
  price: EnlittPrice | undefined,
  context: PremiumPriceContext
): Promise<string> {
  if (price === undefined) {
    return "0";
  }
  if (typeof price === "string") {
    return price;
  }
  try {
    return assertNanoUsd(await price(context), "price() result");
  } catch (thrown) {
    const detail = thrown instanceof Error ? thrown.message : "the price function failed";
    client.onTerminalReportError?.(
      thrown instanceof EnlittConfigurationError
        ? thrown
        : new EnlittConfigurationError(`The price function failed, so the call was charged "0": ${detail}`)
    );
    return "0";
  }
}

// --- Generate --------------------------------------------------------------

/**
 * The Vercel adapter over `runPremiumCharge()` for a non-streaming call.
 *
 * A result is `completed`, a `length` finish included. A rejection while the
 * call is canceled evaluates `price` with `status: "canceled"`, no usage, and
 * empty content before rethrowing. Any other provider error is `failed`, is
 * rethrown unchanged, and never calls `price`.
 */
export function wrapPremiumGenerate(
  client: InternalEnlittClient,
  request: PremiumChargeRequest,
  price: EnlittPrice | undefined,
  run: () => Promise<GenerateResult>
): Promise<GenerateResult> {
  return runPremiumCharge(client, request, async (charge, operation) => {
    const startedAt = new Date();
    let result: GenerateResult;
    try {
      result = await run();
    } catch (thrown) {
      if (isCancellation(thrown, request.signal)) {
        const endedAt = new Date();
        charge(
          await evaluatePrice(client, price, {
            status: "canceled",
            output: { kind: "generate", content: [] },
            startedAt,
            endedAt,
            durationMs: endedAt.getTime() - startedAt.getTime(),
            effectiveMaxChargeNanoUsd: operation.effectiveMaxChargeNanoUsd
          })
        );
        operation.describe({
          timing: timingFacts(startedAt, endedAt),
          delivery: { outputStarted: false, outputCompleted: false },
          errorCategory: "canceled"
        });
      } else {
        operation.describe({
          timing: timingFacts(startedAt, new Date()),
          delivery: { outputStarted: false, outputCompleted: false },
          errorCategory: "provider"
        });
      }
      // Rethrown completely unchanged: a provider's own error must never become
      // an `EnlittError`, and the core rethrows exactly what it is given.
      throw thrown;
    }

    const endedAt = new Date();
    charge(
      await evaluatePrice(client, price, {
        status: "completed",
        output: { kind: "generate", content: result.content },
        usage: result.usage,
        finishReason: result.finishReason,
        ...(result.providerMetadata !== undefined ? { providerMetadata: result.providerMetadata } : {}),
        startedAt,
        endedAt,
        durationMs: endedAt.getTime() - startedAt.getTime(),
        effectiveMaxChargeNanoUsd: operation.effectiveMaxChargeNanoUsd
      })
    );
    operation.describe({
      timing: timingFacts(startedAt, endedAt),
      delivery: { outputStarted: true, outputCompleted: true },
      finishReason: result.finishReason.unified,
      ...(result.response?.id !== undefined ? { providerResponseId: result.response.id } : {}),
      ...usageFacts(result.usage)
    });

    return attachEnlittMetadataToGenerateResult(result, operation);
  });
}

// --- Stream ----------------------------------------------------------------

/** The stream parts that count as the model having started producing content (for time to first token). */
const CONTENT_PART_TYPES: ReadonlySet<string> = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-input-delta",
  "tool-call",
  "file",
  "source"
]);

/** How a wrapped stream ended, decided exactly once by its settle latch. */
type StreamOutcome = "completed" | "failed" | "canceled";

/** The two ends of the promise the core's `run` is parked on while a stream is open. */
interface RunSettler {
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/**
 * The Vercel adapter over `runPremiumCharge()` for a streaming call.
 *
 * The returned promise resolves with the wrapped `StreamResult` as soon as the
 * provider's `doStream` resolves, while the core's `run` stays pending until
 * the stream terminates, so `doStream` returns as early as the unwrapped model
 * would. A begin refusal rejects `doStream` before the provider is invoked, and
 * a provider that rejects outright is reported `failed` and rethrown unchanged.
 *
 * The returned stream passes every part through unchanged, unbuffered, and with
 * backpressure preserved (it reads one source chunk per consumer pull),
 * collecting parts only when `price` is a function. A finish part (a `length`
 * finish included) settles the operation `completed`; an error part, a source
 * error, or a source that ends with no finish settles it `failed`; consumer
 * cancellation or an aborted `request.signal` settles it `canceled`. Creating a
 * stream reports nothing; the report is sent when the stream terminates, and
 * the stream is not closed until it has been sent, so a serverless process
 * cannot end between the last part and its report. A rejection the core raises
 * after the stream was returned is observed here and never becomes an
 * unhandled rejection.
 */
export function wrapPremiumStream(
  client: InternalEnlittClient,
  request: PremiumChargeRequest,
  price: EnlittPrice | undefined,
  run: () => Promise<StreamResult>
): Promise<StreamResult> {
  return new Promise<StreamResult>((resolveStreamResult, rejectStreamResult) => {
    const settler = {} as RunSettler;

    const lifecycle: Promise<void> = runPremiumCharge(client, request, async (charge, operation) => {
      const startedAt = new Date();
      let result: StreamResult;
      try {
        result = await run();
      } catch (thrown) {
        operation.describe({
          timing: timingFacts(startedAt, new Date()),
          delivery: { outputStarted: false, outputCompleted: false },
          errorCategory: isCancellation(thrown, request.signal) ? "canceled" : "provider"
        });
        throw thrown;
      }

      const parked = new Promise<void>((resolve, reject) => {
        settler.resolve = resolve;
        settler.reject = reject;
      });
      resolveStreamResult(wrapStream(client, request, price, result, charge, operation, startedAt, settler, lifecycle));
      return parked;
    });

    // Before the stream is returned this rejection is `doStream`'s own (a begin
    // refusal or a provider rejection, rethrown unchanged). Afterwards the
    // outer promise has already resolved, so this is a no-op that only observes
    // the rejection a failed or canceled stream's report path ends with.
    lifecycle.catch(rejectStreamResult);
  });
}

/**
 * Builds the pass-through stream and its settle latch for one operation.
 * Split out of {@link wrapPremiumStream} so the latch reads top to bottom.
 */
function wrapStream(
  client: InternalEnlittClient,
  request: PremiumChargeRequest,
  price: EnlittPrice | undefined,
  result: StreamResult,
  charge: PremiumChargeFunction,
  operation: PremiumChargeHandle,
  startedAt: Date,
  settler: RunSettler,
  lifecycle: Promise<unknown>
): StreamResult {
  const collectParts = typeof price === "function";
  const parts: LanguageModelV3StreamPart[] = [];
  const reader = result.stream.getReader();

  let outputStarted = false;
  let firstContentAt: Date | undefined;
  let finish: Extract<LanguageModelV3StreamPart, { type: "finish" }> | undefined;
  let sawErrorPart = false;
  let responseId: string | undefined;

  /** The latch: the first caller decides the outcome; every later caller awaits the same settlement. */
  let settlement: Promise<void> | undefined;
  const settle = (outcome: StreamOutcome): Promise<void> => {
    settlement ??= (async () => {
      const endedAt = new Date();
      const facts = {
        timing: timingFacts(startedAt, endedAt),
        delivery: { outputStarted, outputCompleted: outcome === "completed" }
      };

      if (outcome === "failed") {
        // `price` is never called for a failure, and the core reports "0".
        operation.describe({ ...facts, errorCategory: "provider" });
        settler.reject(new Error("The provider stream failed."));
      } else {
        charge(
          await evaluatePrice(client, price, {
            status: outcome,
            output: { kind: "stream", parts },
            ...(finish !== undefined ? { usage: finish.usage, finishReason: finish.finishReason } : {}),
            ...(finish?.providerMetadata !== undefined ? { providerMetadata: finish.providerMetadata } : {}),
            startedAt,
            endedAt,
            durationMs: endedAt.getTime() - startedAt.getTime(),
            ...(firstContentAt !== undefined
              ? { timeToFirstTokenMs: firstContentAt.getTime() - startedAt.getTime() }
              : {}),
            effectiveMaxChargeNanoUsd: operation.effectiveMaxChargeNanoUsd
          })
        );
        operation.describe({
          ...facts,
          ...(finish !== undefined ? { finishReason: finish.finishReason.unified, ...usageFacts(finish.usage) } : {}),
          ...(responseId !== undefined ? { providerResponseId: responseId } : {}),
          ...(outcome === "canceled" ? { errorCategory: "canceled" as const } : {})
        });
        if (outcome === "completed") {
          settler.resolve();
        } else {
          // The core classifies a rejection named AbortError as canceled.
          settler.reject(Object.assign(new Error("The stream was canceled."), { name: "AbortError" }));
        }
      }
      // Wait for the one terminal report so the stream never closes before it.
      await lifecycle.catch(() => undefined);
    })();
    return settlement;
  };

  const stream = new ReadableStream<LanguageModelV3StreamPart>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<LanguageModelV3StreamPart>;
      try {
        chunk = await reader.read();
      } catch (thrown) {
        await settle(isCancellation(thrown, request.signal) ? "canceled" : "failed");
        controller.error(thrown);
        return;
      }

      if (chunk.done) {
        await settle(finish !== undefined && !sawErrorPart ? "completed" : "failed");
        controller.close();
        return;
      }

      const part = chunk.value;
      if (collectParts) parts.push(part);
      if (part.type === "response-metadata" && part.id !== undefined) responseId = part.id;
      if (CONTENT_PART_TYPES.has(part.type)) {
        outputStarted = true;
        firstContentAt ??= new Date();
      }
      if (part.type === "error") sawErrorPart = true;

      if (part.type === "finish") {
        finish = part;
        controller.enqueue({
          ...part,
          providerMetadata: {
            ...part.providerMetadata,
            enlitt: {
              operationId: operation.operationId,
              effectiveMaxChargeNanoUsd: operation.effectiveMaxChargeNanoUsd
            }
          }
        });
      } else {
        controller.enqueue(part);
      }
    },

    async cancel(reason) {
      // Consumer cancellation: stop the source, then settle as canceled.
      await reader.cancel(reason).catch(() => undefined);
      await settle("canceled");
    }
  });

  return { ...result, stream };
}

// --- Small shared helpers ----------------------------------------------------

/** The content-free timing bracket as the wire reports it. */
function timingFacts(startedAt: Date, endedAt: Date): { startedAt: string; endedAt: string } {
  return { startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString() };
}

/** Token counts for the terminal report, omitting any total the provider did not report. */
function usageFacts(usage: LanguageModelV3Usage): Pick<PremiumTerminalFacts, "usage"> {
  const counts: NonNullable<PremiumTerminalFacts["usage"]> = {
    ...(usage.inputTokens.total !== undefined ? { inputTokens: usage.inputTokens.total } : {}),
    ...(usage.outputTokens.total !== undefined ? { outputTokens: usage.outputTokens.total } : {}),
    ...(usage.inputTokens.cacheRead !== undefined ? { cachedInputTokens: usage.inputTokens.cacheRead } : {}),
    ...(usage.outputTokens.reasoning !== undefined ? { reasoningTokens: usage.outputTokens.reasoning } : {})
  };
  return Object.keys(counts).length > 0 ? { usage: counts } : {};
}

/** Adds `providerMetadata.enlitt` to a non-streaming result without touching anything else. */
function attachEnlittMetadataToGenerateResult(result: GenerateResult, operation: PremiumChargeHandle): GenerateResult {
  return {
    ...result,
    providerMetadata: {
      ...result.providerMetadata,
      enlitt: {
        operationId: operation.operationId,
        effectiveMaxChargeNanoUsd: operation.effectiveMaxChargeNanoUsd
      }
    }
  };
}
