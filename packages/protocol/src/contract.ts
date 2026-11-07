import {
  APPLICATION_ENVIRONMENTS,
  APPLICATION_STATUSES,
  CLI_AUTHORIZATION_KINDS,
  API_KEY_SCOPES,
  API_KEY_STATUSES,
  CHANGE_MODES,
  LOCKED_DOWNGRADE_MODES,
  CONNECTED_ACCOUNT_STATUSES,
  CONTACT_TYPES,
  EMAIL_SIGN_IN_ACCOUNT_TYPES,
  ORDER_KINDS,
  ORDER_STATUSES,
  PAYOUT_BLOCKED_REASONS,
  PERSONAL_APPLICATION_CALL_CREDIT_TYPES,
  PERSONAL_APPLICATION_CALL_SORTS,
  PERSONAL_APPLICATION_CALL_STATUSES,
  PLAN_INTERVALS,
  REFUND_ELIGIBILITY,
  REFUND_REASONS,
  SERVICE_TIERS,
  SUBSCRIPTION_STATUSES,
  validateBusinessDashboardInfo
} from "./dashboard.js";
import {
  ENLITT_API_VERSION,
  ENLITT_VERSION_HEADER,
  UNKNOWN_ENUM_VALUE,
  UNRECOGNIZED_ERROR_CODE,
  type ParseOptions
} from "./compatibility.js";
import { ENLITT_ERROR_CODES, ENLITT_ERROR_TYPES } from "./errors.js";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_MIN_RETENTION_DAYS
} from "./idempotency.js";
import {
  PREMIUM_OPERATION_BILLING_VALUES,
  PREMIUM_TERMINAL_STATUSES,
  validateBeginPremiumOperationRequest,
  validateBeginPremiumOperationResponse,
  validateReportPremiumTerminalRequest,
  validateReportPremiumTerminalResponse
} from "./premium-operations.js";
import { RESPONSE_STREAM_EVENT_TYPE_NAMES } from "./response-stream.js";
import {
  RESPONSE_INCOMPLETE_REASONS,
  RESPONSE_ITEM_STATUSES,
  RESPONSE_STATUSES,
  validateEnlittStandardRequest,
  validateOpenAIResponse,
  type ResponseValidationResult
} from "./responses.js";
import { validateUsageResponse } from "./usage.js";

export const WIRE_CONTRACT_FORMAT = 1;

/** Every closed string set a response parser must handle in strict and tolerant modes. */
export const WIRE_CLOSED_SETS = Object.freeze({
  "api_key.scope": API_KEY_SCOPES,
  "api_key.status": API_KEY_STATUSES,
  "application.environment": APPLICATION_ENVIRONMENTS,
  "application.status": APPLICATION_STATUSES,
  "cli_authorization.kind": CLI_AUTHORIZATION_KINDS,
  "contact.type": CONTACT_TYPES,
  "email_sign_in.account_type": EMAIL_SIGN_IN_ACCOUNT_TYPES,
  "order.kind": ORDER_KINDS,
  "order.refund.eligibility": REFUND_ELIGIBILITY,
  "order.refund.reason": REFUND_REASONS,
  "order.status": ORDER_STATUSES,
  "payout.blocked_reason": PAYOUT_BLOCKED_REASONS,
  "payout.connected_account_status": CONNECTED_ACCOUNT_STATUSES,
  "personal_application_call.credit_type": PERSONAL_APPLICATION_CALL_CREDIT_TYPES,
  "personal_application_call.sort": PERSONAL_APPLICATION_CALL_SORTS,
  "personal_application_call.status": PERSONAL_APPLICATION_CALL_STATUSES,
  "plan.interval": PLAN_INTERVALS,
  "premium_operation.billing": PREMIUM_OPERATION_BILLING_VALUES,
  "premium_terminal.status": PREMIUM_TERMINAL_STATUSES,
  "response.incomplete_details.reason": RESPONSE_INCOMPLETE_REASONS,
  "response.output_item.status": RESPONSE_ITEM_STATUSES,
  "response.status": RESPONSE_STATUSES,
  "response_stream.type": RESPONSE_STREAM_EVENT_TYPE_NAMES,
  "subscription.change_mode": CHANGE_MODES,
  "subscription.locked_downgrade": LOCKED_DOWNGRADE_MODES,
  "subscription.service_tier": SERVICE_TIERS,
  "subscription.status": SUBSCRIPTION_STATUSES
} as const);

export interface WireContract {
  readonly contract_format: typeof WIRE_CONTRACT_FORMAT;
  readonly api_version: string;
  readonly version_header: string;
  readonly unknown_enum_value: string;
  readonly unrecognized_error_code: string;
  readonly idempotency_key: {
    readonly min_length: number;
    readonly max_length: number;
    readonly min_retention_days: number;
  };
  readonly error_types: readonly string[];
  readonly error_codes: Readonly<Record<string, {
    readonly type: string;
    readonly http_status: number;
    readonly retryable: boolean;
    readonly retry_after: "required" | "forbidden";
    readonly authorize_url: "allowed" | "forbidden";
    readonly admissible_max_charge: "allowed" | "forbidden";
    readonly limit_rule: "required" | "forbidden";
  }>>;
  readonly closed_sets: Readonly<Record<string, readonly string[]>>;
}

export function buildWireContract(): WireContract {
  return {
    contract_format: WIRE_CONTRACT_FORMAT,
    api_version: ENLITT_API_VERSION,
    version_header: ENLITT_VERSION_HEADER,
    unknown_enum_value: UNKNOWN_ENUM_VALUE,
    unrecognized_error_code: UNRECOGNIZED_ERROR_CODE,
    idempotency_key: {
      min_length: IDEMPOTENCY_KEY_MIN_LENGTH,
      max_length: IDEMPOTENCY_KEY_MAX_LENGTH,
      min_retention_days: IDEMPOTENCY_KEY_MIN_RETENTION_DAYS
    },
    error_types: ENLITT_ERROR_TYPES,
    error_codes: Object.fromEntries(Object.entries(ENLITT_ERROR_CODES).map(([code, definition]) => [code, {
      type: definition.type,
      http_status: definition.status,
      retryable: definition.retryable,
      retry_after: definition.retryAfter,
      authorize_url: definition.authorizeUrl,
      admissible_max_charge: definition.admissibleMaxCharge,
      limit_rule: definition.limitRule
    }])),
    closed_sets: WIRE_CLOSED_SETS
  };
}

function sortRecord<T>(value: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key] as T]));
}

export function serializeWireContract(contract: WireContract): string {
  return `${JSON.stringify({ ...contract, error_codes: sortRecord(contract.error_codes), closed_sets: sortRecord(contract.closed_sets) }, null, 2)}\n`;
}

export type FixtureEndpoint = "create-response" | "begin-operation" | "report-terminal" | "usage" | "business-info";

interface FixtureEndpointDefinition {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly validateRequest: ((value: unknown) => ResponseValidationResult<unknown>) | null;
  readonly validateResponse: (value: unknown, options?: ParseOptions) => ResponseValidationResult<unknown>;
}

export const FIXTURE_ENDPOINTS: Readonly<Record<FixtureEndpoint, FixtureEndpointDefinition>> = Object.freeze({
  "create-response": { method: "POST", path: "/v1/responses", validateRequest: validateEnlittStandardRequest, validateResponse: validateOpenAIResponse },
  "begin-operation": { method: "POST", path: "/v1/enlitt/operations", validateRequest: validateBeginPremiumOperationRequest, validateResponse: validateBeginPremiumOperationResponse },
  "report-terminal": { method: "POST", path: "/v1/enlitt/operations/{operation_id}/terminal", validateRequest: validateReportPremiumTerminalRequest, validateResponse: validateReportPremiumTerminalResponse },
  usage: { method: "GET", path: "/v1/enlitt/usage", validateRequest: null, validateResponse: validateUsageResponse },
  "business-info": { method: "GET", path: "/v1/business/info", validateRequest: null, validateResponse: validateBusinessDashboardInfo }
});
