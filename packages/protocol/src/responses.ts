/**
 * The stateless `POST /v1/responses` wire contract: request body, response
 * body, and the hand-written runtime validators for both.
 *
 * `specs/PROTOCOLS.md` "Create model response" names an exact accepted field
 * list, an exact rejected field list, and three failure classes a validator
 * must distinguish so the backend can raise the right stable code and the SDK
 * can classify it the same way from the same table. This module owns that
 * classification once, the same way `errors.ts` owns the code table: the
 * backend and the SDK both import it rather than each re-deriving which
 * field belongs to which class.
 *
 * This package has zero runtime dependencies, so validation here is
 * hand-written structural checking rather than a schema library. A validator
 * never throws on ordinary bad input — it returns a result, because an
 * `invalid_value` on request field 40 of 40 is routine traffic, not a bug in
 * this process.
 *
 * Two shapes in `specs/PROTOCOLS.md` are gestured at but not enumerated in the
 * "Create model response" section: `JsonSchema` is used as a type ("bounded
 * ... schema depth, and encoded size") without the bound values being stated,
 * and `ResponseOutputItem` is named without its member shapes being spelled
 * out the way input items are. This module deliberately does not invent
 * numeric bounds or output-item field shapes the spec does not give; see the
 * doc comments on `JsonSchema`, `FunctionTool`, and `ResponseOutputItem` for
 * exactly what is and is not enforced, and the implementation report for the
 * ambiguity this leaves open.
 */

import { ENLITT_ERROR_CODE, type EnlittErrorCode } from "./errors.js";
import {
  UNKNOWN_ENUM_VALUE,
  type ParseOptions,
  type Readable,
  type UnknownVariant
} from "./compatibility.js";

/**
 * The only accepted value of the request's `model` field. A single accepted
 * string is deliberate: the caller asks for the standard route and Enlitt
 * alone decides which model actually serves it, so there is no override to
 * validate the shape of.
 */
export const ENLITT_STANDARD_MODEL = "enlitt-standard";
export type EnlittStandardModel = typeof ENLITT_STANDARD_MODEL;

/**
 * The three failure classes `specs/PROTOCOLS.md` names for this surface,
 * narrowed from the full stable-code union so a caller cannot construct a
 * validation failure carrying a code this surface never raises. Codes are
 * referenced through `ENLITT_ERROR_CODE`'s own keys rather than written as
 * string literals, so a rename in `errors.ts` fails this file to compile
 * instead of silently drifting.
 */
export type ResponseRequestErrorCode = Extract<
  EnlittErrorCode,
  "invalid_value" | "unsupported_parameter" | "unsupported_value"
>;

/**
 * A single validation failure. `param` names the offending field using the
 * same dotted/bracketed path an OpenAI-shaped error already uses, so the
 * value here can be copied directly into `EnlittErrorInput.param` at the call
 * site without renaming anything.
 */
export interface ResponseValidationFailure {
  readonly code: ResponseRequestErrorCode;
  readonly param: string;
  readonly message: string;
}

/**
 * The result shape every validator in this module returns. Ordinary
 * validation failure is data, not an exception: a request body is untrusted
 * input on the hottest path this package serves, and throwing for the
 * expected case would force every caller to wrap every call in `try/catch`.
 */
export type ResponseValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ResponseValidationFailure };

function ok<T>(value: T): ResponseValidationResult<T> {
  return { ok: true, value };
}

function unsupportedParameter(param: string, message: string): ResponseValidationResult<never> {
  return { ok: false, error: { code: ENLITT_ERROR_CODE.unsupported_parameter, param, message } };
}

function unsupportedValue(param: string, message: string): ResponseValidationResult<never> {
  return { ok: false, error: { code: ENLITT_ERROR_CODE.unsupported_value, param, message } };
}

function invalidValue(param: string, message: string): ResponseValidationResult<never> {
  return { ok: false, error: { code: ENLITT_ERROR_CODE.invalid_value, param, message } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON Schema object supplied to a function tool. */
export type JsonSchema = Readonly<Record<string, unknown>>;

function validateJsonSchema(value: unknown, param: string): ResponseValidationResult<JsonSchema> {
  if (!isPlainObject(value)) return invalidValue(param, "must be a JSON Schema object");
  return ok(value);
}

export interface EnlittTextPart {
  readonly type: "text";
  readonly text: string;
}

export interface EnlittImageUrlSource {
  readonly type: "url";
  readonly url: string;
}

export interface EnlittImageBase64Source {
  readonly type: "base64";
  readonly media_type: "image/png" | "image/jpeg";
  readonly data: string;
}

export interface EnlittImagePart {
  readonly type: "image";
  readonly source: EnlittImageUrlSource | EnlittImageBase64Source;
}

export type EnlittUserPart = EnlittTextPart | EnlittImagePart;

export interface EnlittSystemMessage {
  readonly role: "system";
  readonly content: string;
}

export interface EnlittUserMessage {
  readonly role: "user";
  readonly content: readonly EnlittUserPart[];
}

export interface EnlittToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface EnlittAssistantMessage {
  readonly role: "assistant";
  readonly content?: string;
  readonly tool_calls?: readonly EnlittToolCall[];
}

export interface EnlittToolMessage {
  readonly role: "tool";
  readonly tool_call_id: string;
  readonly content: string;
}

export type EnlittStandardMessage =
  | EnlittSystemMessage
  | EnlittUserMessage
  | EnlittAssistantMessage
  | EnlittToolMessage;

export interface EnlittFunctionTool {
  readonly name: string;
  readonly description?: string;
  readonly input_schema: JsonSchema;
}

const MAX_TOOLS = 64;
const MAX_IMAGES = 16;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 4096;

function ensureOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, param: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return unsupportedParameter(param ? `${param}.${key}` : key, `"${key}" is not accepted`);
  }
  return undefined;
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function pngDimensions(bytes: Uint8Array): readonly [number, number] | undefined {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) return undefined;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

function jpegDimensions(bytes: Uint8Array): readonly [number, number] | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return undefined;
    const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (length < 2 || offset + length > bytes.length) return undefined;
    if (sofMarkers.has(marker)) {
      if (length < 7) return undefined;
      return [((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0), ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0)];
    }
    offset += length;
  }
  return undefined;
}

function validateImageSource(value: unknown, param: string): ResponseValidationResult<EnlittImagePart["source"]> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an image source object");
  const type = value.type;
  if (type === "url") {
    const keys = ensureOnlyKeys(value, new Set(["type", "url"]), param);
    if (keys) return keys;
    if (typeof value.url !== "string") return invalidValue(`${param}.url`, "must be a string");
    try {
      if (new URL(value.url).protocol !== "https:") return invalidValue(`${param}.url`, "must be an absolute HTTPS URL");
    } catch {
      return invalidValue(`${param}.url`, "must be an absolute HTTPS URL");
    }
    return ok({ type: "url", url: value.url });
  }
  if (type === "base64") {
    const keys = ensureOnlyKeys(value, new Set(["type", "media_type", "data"]), param);
    if (keys) return keys;
    if (value.media_type !== "image/png" && value.media_type !== "image/jpeg") {
      return unsupportedValue(`${param}.media_type`, 'must be "image/png" or "image/jpeg"');
    }
    if (typeof value.data !== "string") return invalidValue(`${param}.data`, "must be a base64 string");
    const bytes = decodeBase64(value.data);
    if (!bytes) return invalidValue(`${param}.data`, "must be canonical base64 image data");
    if (bytes.byteLength > MAX_IMAGE_BYTES) return invalidValue(`${param}.data`, `decoded image must not exceed ${MAX_IMAGE_BYTES} bytes`);
    const dimensions = value.media_type === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
    if (!dimensions) return invalidValue(`${param}.data`, `must contain a valid ${value.media_type} header with dimensions`);
    if (dimensions[0] < 1 || dimensions[1] < 1 || dimensions[0] > MAX_IMAGE_DIMENSION || dimensions[1] > MAX_IMAGE_DIMENSION) {
      return invalidValue(`${param}.data`, `image dimensions must be between 1 and ${MAX_IMAGE_DIMENSION} pixels`);
    }
    return ok({ type: "base64", media_type: value.media_type, data: value.data });
  }
  if (typeof type !== "string") return invalidValue(`${param}.type`, "must be a string");
  return unsupportedValue(`${param}.type`, `unknown image source type "${type}"`);
}

function validateUserPart(
  value: unknown,
  param: string
): ResponseValidationResult<EnlittUserPart> {
  if (!isPlainObject(value)) return invalidValue(param, "must be a content part object");
  const type = value.type;
  if (typeof type !== "string") return invalidValue(`${param}.type`, "content part type must be a string");
  if (type === "text") {
    const keys = ensureOnlyKeys(value, new Set(["type", "text"]), param);
    if (keys) return keys;
    if (typeof value.text !== "string" || value.text.length === 0) return invalidValue(`${param}.text`, "must be a non-empty string");
    return ok({ type: "text", text: value.text });
  }
  if (type === "image") {
    const keys = ensureOnlyKeys(value, new Set(["type", "source"]), param);
    if (keys) return keys;
    const source = validateImageSource(value.source, `${param}.source`);
    return source.ok ? ok({ type: "image", source: source.value }) : source;
  }
  return unsupportedValue(`${param}.type`, `unknown content part type "${type}"`);
}

function validateFunctionTool(value: unknown, param: string): ResponseValidationResult<EnlittFunctionTool> {
  if (!isPlainObject(value)) return invalidValue(param, "must be a function tool object");
  const keys = ensureOnlyKeys(value, new Set(["name", "description", "input_schema"]), param);
  if (keys) return keys;
  const name = value.name;
  if (typeof name !== "string" || name.length === 0) {
    return invalidValue(`${param}.name`, "must be a non-empty string");
  }

  const description = value.description;
  if (description !== undefined && typeof description !== "string") {
    return invalidValue(`${param}.description`, "must be a string");
  }

  const schemaResult = validateJsonSchema(value.input_schema, `${param}.input_schema`);
  if (!schemaResult.ok) return schemaResult;
  const tool: { -readonly [K in keyof EnlittFunctionTool]: EnlittFunctionTool[K] } = {
    name,
    input_schema: schemaResult.value
  };
  if (description !== undefined) tool.description = description;
  return ok(tool);
}

function validateFunctionTools(
  value: unknown,
  param: string
): ResponseValidationResult<readonly EnlittFunctionTool[]> {
  if (!Array.isArray(value)) return invalidValue(param, "must be an array of function tools");
  if (value.length > MAX_TOOLS) return invalidValue(param, `must not contain more than ${MAX_TOOLS} tools`);
  const tools: EnlittFunctionTool[] = [];
  for (const [index, item] of value.entries()) {
    const result = validateFunctionTool(item, `${param}[${index}]`);
    if (!result.ok) return result;
    tools.push(result.value);
  }
  return ok(tools);
}

/**
 * The identical caller-metadata bound `specs/PROTOCOLS.md` states once and
 * both the SDK and the premium path must apply without restating: at most 16
 * entries, keys at most 64 characters, values at most 512, and no caller key
 * beginning with `enlitt_` (that prefix is reserved for facts Enlitt adds to
 * a response, such as `enlitt_operation_id`).
 */
export const CALLER_METADATA_LIMITS = Object.freeze({
  maxEntries: 16,
  maxKeyLength: 64,
  maxValueLength: 512,
  reservedKeyPrefix: "enlitt_"
});

export type ResponseMetadata = Readonly<Record<string, string>>;

/**
 * Validate caller-supplied metadata against the one bound this surface, the
 * premium path, and the SDK all share. Exported standalone — not folded into
 * `validateEnlittStandardRequest` — precisely so a second copy of this
 * rule never needs to be written next to a different endpoint's field list.
 */
export function validateCallerMetadata(
  value: unknown,
  param = "metadata"
): ResponseValidationResult<ResponseMetadata> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object of string values");
  const entries = Object.entries(value);
  if (entries.length > CALLER_METADATA_LIMITS.maxEntries) {
    return invalidValue(param, `must not have more than ${CALLER_METADATA_LIMITS.maxEntries} entries`);
  }
  const metadata: Record<string, string> = {};
  for (const [key, entryValue] of entries) {
    if (key.length > CALLER_METADATA_LIMITS.maxKeyLength) {
      return invalidValue(
        `${param}.${key}`,
        `key must not exceed ${CALLER_METADATA_LIMITS.maxKeyLength} characters`
      );
    }
    if (key.startsWith(CALLER_METADATA_LIMITS.reservedKeyPrefix)) {
      return invalidValue(`${param}.${key}`, `key must not begin with "${CALLER_METADATA_LIMITS.reservedKeyPrefix}"`);
    }
    if (typeof entryValue !== "string") {
      return invalidValue(`${param}.${key}`, "value must be a string");
    }
    if (entryValue.length > CALLER_METADATA_LIMITS.maxValueLength) {
      return invalidValue(
        `${param}.${key}`,
        `value must not exceed ${CALLER_METADATA_LIMITS.maxValueLength} characters`
      );
    }
    metadata[key] = entryValue;
  }
  return ok(metadata);
}

const ACCEPTED_REQUEST_FIELDS = new Set(["model", "messages", "tools", "max_output_tokens", "stream", "metadata"]);

export interface EnlittStandardRequest {
  readonly model: EnlittStandardModel;
  readonly messages: readonly EnlittStandardMessage[];
  readonly tools?: readonly EnlittFunctionTool[];
  readonly max_output_tokens?: number;
  readonly stream?: boolean;
  readonly metadata?: ResponseMetadata;
}

function validateMessages(value: unknown): ResponseValidationResult<readonly EnlittStandardMessage[]> {
  if (!Array.isArray(value) || value.length === 0) return invalidValue("messages", "must be a non-empty array");
  const messages: EnlittStandardMessage[] = [];
  const toolCalls = new Set<string>();
  const toolResults = new Set<string>();
  let imageCount = 0;
  for (const [index, item] of value.entries()) {
    const param = `messages[${index}]`;
    if (!isPlainObject(item)) return invalidValue(param, "must be a message object");
    const role = item.role;
    if (role === "system") {
      const keys = ensureOnlyKeys(item, new Set(["role", "content"]), param);
      if (keys) return keys;
      if (typeof item.content !== "string" || item.content.length === 0) return invalidValue(`${param}.content`, "must be a non-empty string");
      messages.push({ role, content: item.content });
      continue;
    }
    if (role === "user") {
      const keys = ensureOnlyKeys(item, new Set(["role", "content"]), param);
      if (keys) return keys;
      if (!Array.isArray(item.content) || item.content.length === 0) return invalidValue(`${param}.content`, "must be a non-empty array");
      const parts: EnlittUserPart[] = [];
      for (const [partIndex, rawPart] of item.content.entries()) {
        const part = validateUserPart(rawPart, `${param}.content[${partIndex}]`);
        if (!part.ok) return part;
        if (part.value.type === "image" && ++imageCount > MAX_IMAGES) return invalidValue("messages", `must not contain more than ${MAX_IMAGES} images`);
        parts.push(part.value);
      }
      messages.push({ role, content: parts });
      continue;
    }
    if (role === "assistant") {
      const keys = ensureOnlyKeys(item, new Set(["role", "content", "tool_calls"]), param);
      if (keys) return keys;
      const content = item.content;
      if (content !== undefined && (typeof content !== "string" || content.length === 0)) return invalidValue(`${param}.content`, "must be a non-empty string");
      const rawCalls = item.tool_calls;
      if (rawCalls !== undefined && (!Array.isArray(rawCalls) || rawCalls.length === 0)) return invalidValue(`${param}.tool_calls`, "must be a non-empty array");
      if (content === undefined && rawCalls === undefined) return invalidValue(param, "assistant message must have content or tool_calls");
      const calls: EnlittToolCall[] = [];
      if (Array.isArray(rawCalls)) {
        for (const [callIndex, rawCall] of rawCalls.entries()) {
          const callParam = `${param}.tool_calls[${callIndex}]`;
          if (!isPlainObject(rawCall)) return invalidValue(callParam, "must be a tool call object");
          const callKeys = ensureOnlyKeys(rawCall, new Set(["id", "name", "arguments"]), callParam);
          if (callKeys) return callKeys;
          if (typeof rawCall.id !== "string" || rawCall.id.length === 0) return invalidValue(`${callParam}.id`, "must be a non-empty string");
          if (toolCalls.has(rawCall.id)) return invalidValue(`${callParam}.id`, "must be unique within the request");
          if (typeof rawCall.name !== "string" || rawCall.name.length === 0) return invalidValue(`${callParam}.name`, "must be a non-empty string");
          if (typeof rawCall.arguments !== "string") return invalidValue(`${callParam}.arguments`, "must be a string");
          toolCalls.add(rawCall.id);
          calls.push({ id: rawCall.id, name: rawCall.name, arguments: rawCall.arguments });
        }
      }
      const message: { role: "assistant"; content?: string; tool_calls?: readonly EnlittToolCall[] } = { role };
      if (content !== undefined) message.content = content;
      if (rawCalls !== undefined) message.tool_calls = calls;
      messages.push(message);
      continue;
    }
    if (role === "tool") {
      const keys = ensureOnlyKeys(item, new Set(["role", "tool_call_id", "content"]), param);
      if (keys) return keys;
      if (typeof item.tool_call_id !== "string" || item.tool_call_id.length === 0) return invalidValue(`${param}.tool_call_id`, "must be a non-empty string");
      if (!toolCalls.has(item.tool_call_id)) return invalidValue(`${param}.tool_call_id`, "must reference an earlier assistant tool call");
      if (toolResults.has(item.tool_call_id)) return invalidValue(`${param}.tool_call_id`, "may appear only once");
      if (typeof item.content !== "string" || item.content.length === 0) return invalidValue(`${param}.content`, "must be a non-empty string");
      toolResults.add(item.tool_call_id);
      messages.push({ role, tool_call_id: item.tool_call_id, content: item.content });
      continue;
    }
    if (typeof role !== "string") return invalidValue(`${param}.role`, "must be a string");
    return unsupportedValue(`${param}.role`, `unknown message role "${role}"`);
  }
  return ok(messages);
}

export function validateEnlittStandardRequest(
  value: unknown
): ResponseValidationResult<EnlittStandardRequest> {
  if (!isPlainObject(value)) return invalidValue("body", "request body must be a JSON object");

  for (const key of Object.keys(value)) {
    if (!ACCEPTED_REQUEST_FIELDS.has(key)) {
      return unsupportedParameter(key, `"${key}" is not accepted by this surface`);
    }
  }

  const modelValue = value.model;
  if (typeof modelValue !== "string") return invalidValue("model", "model is required");
  if (modelValue !== ENLITT_STANDARD_MODEL) {
    return unsupportedValue("model", `model must be "${ENLITT_STANDARD_MODEL}"`);
  }

  const messages = validateMessages(value.messages);
  if (!messages.ok) return messages;
  const request: { -readonly [K in keyof EnlittStandardRequest]?: EnlittStandardRequest[K] } = {
    model: ENLITT_STANDARD_MODEL,
    messages: messages.value
  };

  const tools = value.tools;
  if (tools !== undefined) {
    const toolsResult = validateFunctionTools(tools, "tools");
    if (!toolsResult.ok) return toolsResult;
    request.tools = toolsResult.value;
  }

  const maxOutputTokens = value.max_output_tokens;
  if (maxOutputTokens !== undefined) {
    // The deployed route ceiling this must also fit under is not a fact this
    // package has: it is server configuration, not protocol shape. Only the
    // shape-level bound ("positive integer") is enforced here.
    if (typeof maxOutputTokens !== "number" || !Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
      return invalidValue("max_output_tokens", "must be a positive integer");
    }
    request.max_output_tokens = maxOutputTokens;
  }

  const stream = value.stream;
  if (stream !== undefined) {
    if (typeof stream !== "boolean") return invalidValue("stream", "must be a boolean");
    request.stream = stream;
  }

  const metadata = value.metadata;
  if (metadata !== undefined) {
    const metadataResult = validateCallerMetadata(metadata, "metadata");
    if (!metadataResult.ok) return metadataResult;
    request.metadata = metadataResult.value;
  }

  return ok(request as EnlittStandardRequest);
}

// --- Non-streaming response object -----------------------------------------

export const RESPONSE_STATUSES = Object.freeze([
  "completed",
  "failed",
  "in_progress",
  "cancelled",
  "queued",
  "incomplete"
 ] as const);
const RESPONSE_STATUS_SET = new Set<string>(RESPONSE_STATUSES);
export const RESPONSE_INCOMPLETE_REASONS = Object.freeze(["max_output_tokens"] as const);
const RESPONSE_INCOMPLETE_REASON_SET = new Set<string>(RESPONSE_INCOMPLETE_REASONS);
export const RESPONSE_ITEM_STATUSES = Object.freeze(["in_progress", "completed", "incomplete"] as const);
const ITEM_STATUSES = new Set<string>(RESPONSE_ITEM_STATUSES);

export type ResponseStatusMember =
  | "completed"
  | "failed"
  | "in_progress"
  | "cancelled"
  | "queued"
  | "incomplete";
export type ResponseStatus = Readable<ResponseStatusMember>;
export type ResponseIncompleteReason = Readable<(typeof RESPONSE_INCOMPLETE_REASONS)[number]>;

/**
 * A member of `OpenAIResponse.output`.
 *
 * `specs/PROTOCOLS.md` names `ResponseOutputItem` but, in the section this
 * module implements, does not enumerate its member shapes the way it
 * enumerates input items. The two variants below are modeled on the pinned
 * OpenAI Responses API subset this endpoint implements (the same subset the
 * differential test harness drives) and on the streaming event names the
 * spec does give — `response.output_item.*`, `response.content_part.*`,
 * `response.output_text.*`, and `response.function_call_arguments.*` imply
 * exactly a text-bearing message item and a function-call item and nothing
 * else. This is the closest reading available from the read scope for this
 * task; it is not a spec quotation, and it should be confirmed against
 * wherever `ResponseOutputItem` is actually pinned down before another
 * workspace depends on these exact field names.
 */
export interface ResponseOutputTextPart {
  readonly type: "output_text";
  readonly text: string;
}

export type ResponseOutputContentPart = ResponseOutputTextPart | UnknownVariant;

export interface MessageOutputItem {
  readonly type: "message";
  readonly id: string;
  readonly role: "assistant";
  readonly status: Readable<(typeof RESPONSE_ITEM_STATUSES)[number]>;
  readonly content: readonly ResponseOutputContentPart[];
}

export interface FunctionCallOutputItem {
  readonly type: "function_call";
  readonly id: string;
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
  readonly status: Readable<(typeof RESPONSE_ITEM_STATUSES)[number]>;
}

export type ResponseOutputItem = MessageOutputItem | FunctionCallOutputItem | UnknownVariant;

function isTolerant(options?: ParseOptions): boolean {
  return options?.mode === "tolerant";
}

function rejectResponseUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  param: string,
  options?: ParseOptions
): ResponseValidationResult<never> | undefined {
  if (isTolerant(options)) return undefined;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return invalidValue(param ? `${param}.${key}` : key, `unknown response field "${key}"`);
  }
  return undefined;
}

function readableMember<T extends string>(
  value: unknown,
  members: ReadonlySet<string>,
  param: string,
  options?: ParseOptions
): ResponseValidationResult<Readable<T>> {
  if (typeof value !== "string") return invalidValue(param, "must be a string");
  if (members.has(value)) return ok(value as T);
  return isTolerant(options) ? ok(UNKNOWN_ENUM_VALUE) : unsupportedValue(param, `unknown value "${value}"`);
}

export function validateOutputTextPart(
  value: unknown,
  param: string,
  options?: ParseOptions
): ResponseValidationResult<ResponseOutputContentPart> {
  if (!isPlainObject(value)) return invalidValue(param, "must be a content part object");
  if (value.type !== "output_text") {
    if (isTolerant(options) && typeof value.type === "string" && value.type.length <= 64) {
      return ok({ unknown: true, type: value.type });
    }
    return unsupportedValue(`${param}.type`, `unknown output content part type "${String(value.type)}"`);
  }
  const keys = rejectResponseUnknownKeys(value, new Set(["type", "text"]), param, options);
  if (keys) return keys;
  const text = value.text;
  if (typeof text !== "string") return invalidValue(`${param}.text`, "must be a string");
  return ok({ type: "output_text", text });
}

export function validateResponseOutputItem(
  value: unknown,
  param: string,
  options?: ParseOptions
): ResponseValidationResult<ResponseOutputItem> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an output item object");
  const type = value.type;
  if (typeof type !== "string") return invalidValue(`${param}.type`, "must be a string");

  if (type !== "message" && type !== "function_call") {
    if (isTolerant(options) && type.length <= 64) return ok({ unknown: true, type });
    return unsupportedValue(`${param}.type`, `unknown output item type "${type}"`);
  }
  const id = value.id;
  if (typeof id !== "string") return invalidValue(`${param}.id`, "must be a string");
  const statusResult = readableMember<(typeof RESPONSE_ITEM_STATUSES)[number]>(value.status, ITEM_STATUSES, `${param}.status`, options);
  if (!statusResult.ok) return statusResult;
  const status = statusResult.value;

  switch (type) {
    case "message": {
      const keys = rejectResponseUnknownKeys(value, new Set(["type", "id", "role", "status", "content"]), param, options);
      if (keys) return keys;
      if (value.role !== "assistant") return invalidValue(`${param}.role`, 'must be "assistant"');
      const content = value.content;
      if (!Array.isArray(content)) return invalidValue(`${param}.content`, "must be an array");
      const parts: ResponseOutputContentPart[] = [];
      for (const [index, part] of content.entries()) {
        const partResult = validateOutputTextPart(part, `${param}.content[${index}]`, options);
        if (!partResult.ok) return partResult;
        parts.push(partResult.value);
      }
      return ok({
        type: "message",
        id,
        role: "assistant",
        status,
        content: parts
      });
    }
    case "function_call": {
      const keys = rejectResponseUnknownKeys(value, new Set(["type", "id", "call_id", "name", "arguments", "status"]), param, options);
      if (keys) return keys;
      const callId = value.call_id;
      if (typeof callId !== "string") return invalidValue(`${param}.call_id`, "must be a string");
      const name = value.name;
      if (typeof name !== "string") return invalidValue(`${param}.name`, "must be a string");
      const args = value.arguments;
      if (typeof args !== "string") return invalidValue(`${param}.arguments`, "must be a string");
      return ok({
        type: "function_call",
        id,
        call_id: callId,
        name,
        arguments: args,
        status
      });
    }
  }
}

export interface ResponseUsage {
  readonly input_tokens: number;
  readonly input_tokens_details?: { readonly cached_tokens?: number };
  readonly output_tokens: number;
  readonly output_tokens_details?: { readonly reasoning_tokens?: number };
  readonly total_tokens: number;
}

export interface OpenAIResponse {
  readonly id: string;
  readonly object: "response";
  readonly created_at: number;
  readonly completed_at?: number;
  readonly status: ResponseStatus;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly incomplete_details: { readonly reason: ResponseIncompleteReason } | null;
  readonly model: EnlittStandardModel;
  readonly output: readonly ResponseOutputItem[];
  readonly output_text?: string;
  readonly usage?: ResponseUsage;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * Validate an `OpenAIResponse`. Unlike the request validator this is not on
 * the untrusted-input boundary of a hostile caller — it validates what this
 * system itself produced, or what a test fixture claims this system
 * produced — so failures are reported with the same three-class shape for
 * consistency but are expected to be rare in production.
 */
export function validateOpenAIResponse(value: unknown, options?: ParseOptions): ResponseValidationResult<OpenAIResponse> {
  if (!isPlainObject(value)) return invalidValue("body", "response must be a JSON object");
  const rootKeys = rejectResponseUnknownKeys(value, new Set([
    "id", "object", "created_at", "completed_at", "status", "error", "incomplete_details",
    "model", "output", "output_text", "usage", "metadata"
  ]), "", options);
  if (rootKeys) return rootKeys;

  const id = value.id;
  if (typeof id !== "string") return invalidValue("id", "must be a string");

  if (value.object !== "response") return invalidValue("object", 'must be "response"');

  const createdAt = value.created_at;
  if (typeof createdAt !== "number" || !Number.isInteger(createdAt)) {
    return invalidValue("created_at", "must be an integer");
  }

  const completedAt = value.completed_at;
  if (completedAt !== undefined && (typeof completedAt !== "number" || !Number.isInteger(completedAt))) {
    return invalidValue("completed_at", "must be an integer");
  }

  const statusResult = readableMember<ResponseStatusMember>(value.status, RESPONSE_STATUS_SET, "status", options);
  if (!statusResult.ok) return statusResult;
  const status = statusResult.value;

  const errorField = value.error;
  if (errorField !== null) {
    if (!isPlainObject(errorField)) return invalidValue("error", "must be null or an object");
    const keys = rejectResponseUnknownKeys(errorField, new Set(["code", "message"]), "error", options);
    if (keys) return keys;
    if (typeof errorField.code !== "string") return invalidValue("error.code", "must be a string");
    if (typeof errorField.message !== "string") return invalidValue("error.message", "must be a string");
  }

  const incompleteDetails = value.incomplete_details;
  let incompleteReason: ResponseIncompleteReason | undefined;
  if (incompleteDetails !== null) {
    if (!isPlainObject(incompleteDetails)) {
      return invalidValue("incomplete_details", "must be null or an object");
    }
    const keys = rejectResponseUnknownKeys(incompleteDetails, new Set(["reason"]), "incomplete_details", options);
    if (keys) return keys;
    const reasonResult = readableMember<(typeof RESPONSE_INCOMPLETE_REASONS)[number]>(incompleteDetails.reason, RESPONSE_INCOMPLETE_REASON_SET, "incomplete_details.reason", options);
    if (!reasonResult.ok) return reasonResult;
    incompleteReason = reasonResult.value;
  }

  const model = value.model;
  if (model !== ENLITT_STANDARD_MODEL) {
    return unsupportedValue("model", `model must be "${ENLITT_STANDARD_MODEL}"`);
  }

  const outputValue = value.output;
  if (!Array.isArray(outputValue)) return invalidValue("output", "must be an array");
  const output: ResponseOutputItem[] = [];
  for (const [index, item] of outputValue.entries()) {
    const result = validateResponseOutputItem(item, `output[${index}]`, options);
    if (!result.ok) return result;
    output.push(result.value);
  }

  const outputText = value.output_text;
  if (outputText !== undefined && typeof outputText !== "string") {
    return invalidValue("output_text", "must be a string");
  }

  const usageValue = value.usage;
  let usage: ResponseUsage | undefined;
  if (usageValue !== undefined) {
    if (!isPlainObject(usageValue)) return invalidValue("usage", "must be an object");
    const usageKeys = rejectResponseUnknownKeys(usageValue, new Set(["input_tokens", "input_tokens_details", "output_tokens", "output_tokens_details", "total_tokens"]), "usage", options);
    if (usageKeys) return usageKeys;
    const inputTokens = usageValue.input_tokens;
    const outputTokens = usageValue.output_tokens;
    const totalTokens = usageValue.total_tokens;
    if (typeof inputTokens !== "number" || !Number.isInteger(inputTokens)) {
      return invalidValue("usage.input_tokens", "must be an integer");
    }
    if (typeof outputTokens !== "number" || !Number.isInteger(outputTokens)) {
      return invalidValue("usage.output_tokens", "must be an integer");
    }
    if (typeof totalTokens !== "number" || !Number.isInteger(totalTokens)) {
      return invalidValue("usage.total_tokens", "must be an integer");
    }
    usage = { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens };
    if (usageValue.input_tokens_details !== undefined) {
      if (!isPlainObject(usageValue.input_tokens_details)) return invalidValue("usage.input_tokens_details", "must be an object");
      const detailKeys = rejectResponseUnknownKeys(usageValue.input_tokens_details, new Set(["cached_tokens"]), "usage.input_tokens_details", options);
      if (detailKeys) return detailKeys;
      if (usageValue.input_tokens_details.cached_tokens !== undefined && (typeof usageValue.input_tokens_details.cached_tokens !== "number" || !Number.isInteger(usageValue.input_tokens_details.cached_tokens))) return invalidValue("usage.input_tokens_details.cached_tokens", "must be an integer");
      usage = { ...usage, input_tokens_details: usageValue.input_tokens_details.cached_tokens === undefined ? {} : { cached_tokens: usageValue.input_tokens_details.cached_tokens } };
    }
    if (usageValue.output_tokens_details !== undefined) {
      if (!isPlainObject(usageValue.output_tokens_details)) return invalidValue("usage.output_tokens_details", "must be an object");
      const detailKeys = rejectResponseUnknownKeys(usageValue.output_tokens_details, new Set(["reasoning_tokens"]), "usage.output_tokens_details", options);
      if (detailKeys) return detailKeys;
      if (usageValue.output_tokens_details.reasoning_tokens !== undefined && (typeof usageValue.output_tokens_details.reasoning_tokens !== "number" || !Number.isInteger(usageValue.output_tokens_details.reasoning_tokens))) return invalidValue("usage.output_tokens_details.reasoning_tokens", "must be an integer");
      usage = { ...usage, output_tokens_details: usageValue.output_tokens_details.reasoning_tokens === undefined ? {} : { reasoning_tokens: usageValue.output_tokens_details.reasoning_tokens } };
    }
  }

  const metadataValue = value.metadata;
  // A response's metadata carries caller metadata plus safe reserved
  // `enlitt_`-prefixed keys added by the server, so the caller-only bound in
  // `validateCallerMetadata` does not apply here; only the string-map shape
  // is checked.
  if (!isPlainObject(metadataValue)) return invalidValue("metadata", "must be an object of string values");
  const metadata: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(metadataValue)) {
    if (typeof entryValue !== "string") return invalidValue(`metadata.${key}`, "value must be a string");
    metadata[key] = entryValue;
  }

  const response: { -readonly [K in keyof OpenAIResponse]?: OpenAIResponse[K] } = {
    id,
    object: "response",
    created_at: createdAt,
    status,
    error: errorField === null ? null : { code: (errorField).code as string, message: (errorField).message as string },
    incomplete_details:
      incompleteDetails === null
        ? null
        : { reason: incompleteReason! },
    model: ENLITT_STANDARD_MODEL,
    output,
    metadata
  };
  if (completedAt !== undefined) response.completed_at = completedAt;
  if (outputText !== undefined) response.output_text = outputText;
  if (usage !== undefined) response.usage = usage;

  return ok(response as OpenAIResponse);
}
