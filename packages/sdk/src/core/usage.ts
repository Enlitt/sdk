/**
 * The framework-neutral `usage()` helper over `GET /v1/enlitt/usage`.
 *
 * It builds the same internal client as `withPremiumCharge()`, resolves the
 * same personal session (explicit, or ambient from the middleware), performs
 * one authenticated read, and tolerant-parses the response. It returns the two
 * integer percentages and the canonical NANOUSD caps unchanged: no conversion,
 * caching, retry beyond transport policy, or admission inference.
 *
 * The result is advisory. A concurrent call can consume capacity before the
 * caller acts, so it is guidance and never a reservation or quote. It exposes
 * no credit unit, plan, balance, period, rate tuple, or user identity; the wire
 * response carries none and this file adds none.
 */

import { EnlittError } from "./errors.js";
import { createInternalClient, readEnlittJson, requestEnlitt, type EnlittOptions } from "./transport.js";
import { validateUsageResponse } from "@enlitt/protocol";

/** One pool's availability, exactly as the wire reports it. */
export interface UsageAvailability {
  /** An integer from 0 through 100: the floor of the share of this pool still available. */
  readonly remainingPercent: number;
  /** The most this application could reserve for one call right now, as a canonical NANOUSD string. */
  readonly limitCapNanoUsd: string;
}

/** The one relative path this helper reads, per `specs/PROTOCOLS.md`. */
const USAGE_PATH = "/v1/enlitt/usage";

/**
 * Reads the signed-in user's current availability for this application.
 *
 * A missing ambient context raises `EnlittConfigurationError`, a context with
 * no session raises `EnlittLoginRequiredError`, and every refusal (including an
 * unknown error code from a newer server) goes through the shared normalizer,
 * exactly as for a model call. It never raises `spending_limit_exceeded`: the
 * read starts no request-rate budget and reserves nothing.
 */
export async function usage(options: EnlittOptions = {}): Promise<{ readonly standard: UsageAvailability; readonly premium: UsageAvailability }> {
  const client = createInternalClient(options);

  const response = await requestEnlitt(client, {
    path: USAGE_PATH,
    method: "GET",
    accept: "application/json"
  });

  // Tolerant in: unknown response fields are dropped, so a newer server that
  // adds one changes nothing here.
  const parsed = validateUsageResponse(await readEnlittJson(response), { mode: "tolerant" });
  if (!parsed.ok) {
    throw new EnlittError(
      "malformed_response",
      `Enlitt's usage response could not be validated: ${parsed.error.message} (${parsed.error.param}).`
    );
  }

  return {
    standard: {
      remainingPercent: parsed.value.standard.remaining_percent,
      limitCapNanoUsd: parsed.value.standard.limit_cap_nano_usd
    },
    premium: {
      remainingPercent: parsed.value.premium.remaining_percent,
      limitCapNanoUsd: parsed.value.premium.limit_cap_nano_usd
    }
  };
}
