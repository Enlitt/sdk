import { describe, expect, it } from "vitest";

import { ENLITT_ERROR_CODE } from "../src/errors.js";
import {
  CALLER_METADATA_LIMITS,
  ENLITT_STANDARD_MODEL,
  validateCallerMetadata,
  validateEnlittStandardRequest,
  validateOpenAIResponse
} from "../src/responses.js";

const textMessage = { role: "user", content: [{ type: "text", text: "hello" }] };
const request = (overrides: Record<string, unknown> = {}) => ({
  model: ENLITT_STANDARD_MODEL,
  messages: [textMessage],
  ...overrides
});

function expectFailure(value: unknown, code: string, param: string) {
  const result = validateEnlittStandardRequest(value);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatchObject({ code, param });
}

describe("validateEnlittStandardRequest", () => {
  it("accepts the minimal request and optional standard fields", () => {
    const result = validateEnlittStandardRequest(request({
      tools: [{ name: "weather", description: "Get weather", input_schema: { type: "object" } }],
      max_output_tokens: 256,
      stream: true,
      metadata: { tenant: "one" }
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.messages).toEqual([textMessage]);
  });

  it("accepts ordered assistant tool calls and results", () => {
    expect(validateEnlittStandardRequest(request({ messages: [
      textMessage,
      { role: "assistant", tool_calls: [{ id: "call_1", name: "weather", arguments: "{}" }] },
      { role: "tool", tool_call_id: "call_1", content: "sunny" }
    ] })).ok).toBe(true);
  });

  it("rejects all fields outside the small standard surface", () => {
    for (const field of ["input", "instructions", "tool_choice", "text", "temperature", "top_p", "reasoning", "provider_options", "user"]) {
      expectFailure(request({ [field]: true }), ENLITT_ERROR_CODE.unsupported_parameter, field);
    }
  });

  it("rejects invalid model and message shapes", () => {
    expectFailure(request({ model: "provider-model" }), ENLITT_ERROR_CODE.unsupported_value, "model");
    expectFailure(request({ messages: [] }), ENLITT_ERROR_CODE.invalid_value, "messages");
    expectFailure(request({ messages: [{ role: "developer", content: "no" }] }), ENLITT_ERROR_CODE.unsupported_value, "messages[0].role");
    expectFailure(request({ messages: [{ role: "user", content: [{ type: "text", text: "" }] }] }), ENLITT_ERROR_CODE.invalid_value, "messages[0].content[0].text");
  });

  it("rejects invalid tool-result ordering", () => {
    expectFailure(request({ messages: [{ role: "tool", tool_call_id: "x", content: "result" }] }), ENLITT_ERROR_CODE.invalid_value, "messages[0].tool_call_id");
    expectFailure(request({ messages: [
      { role: "assistant", tool_calls: [{ id: "x", name: "a", arguments: "{}" }, { id: "x", name: "b", arguments: "{}" }] }
    ] }), ENLITT_ERROR_CODE.invalid_value, "messages[0].tool_calls[1].id");
  });

  it("accepts HTTPS images and checks base64 dimensions", () => {
    expect(validateEnlittStandardRequest(request({ messages: [{ role: "user", content: [
      { type: "image", source: { type: "url", url: "https://example.com/image.png" } }
    ] }] })).ok).toBe(true);
    expectFailure(request({ messages: [{ role: "user", content: [
      { type: "image", source: { type: "url", url: "http://example.com/image.png" } }
    ] }] }), ENLITT_ERROR_CODE.invalid_value, "messages[0].content[0].source.url");

    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(2, 16);
    png.writeUInt32BE(3, 20);
    expect(validateEnlittStandardRequest(request({ messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }
    ] }] })).ok).toBe(true);
    png.writeUInt32BE(4097, 16);
    expectFailure(request({ messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }
    ] }] }), ENLITT_ERROR_CODE.invalid_value, "messages[0].content[0].source.data");
  });

  it("enforces tool, image, and scalar limits", () => {
    expectFailure(request({ tools: Array.from({ length: 65 }, (_, index) => ({ name: `t${index}`, input_schema: {} })) }), ENLITT_ERROR_CODE.invalid_value, "tools");
    const images = Array.from({ length: 17 }, (_, index) => ({ type: "image", source: { type: "url", url: `https://example.com/${index}.png` } }));
    expectFailure(request({ messages: [{ role: "user", content: images }] }), ENLITT_ERROR_CODE.invalid_value, "messages");
    expectFailure(request({ max_output_tokens: 0 }), ENLITT_ERROR_CODE.invalid_value, "max_output_tokens");
    expectFailure(request({ stream: "yes" }), ENLITT_ERROR_CODE.invalid_value, "stream");
  });
});

describe("validateCallerMetadata", () => {
  it("accepts bounds and rejects reserved keys", () => {
    const metadata = Object.fromEntries(Array.from({ length: CALLER_METADATA_LIMITS.maxEntries }, (_, index) => [`k${index}`, "v".repeat(CALLER_METADATA_LIMITS.maxValueLength)]));
    expect(validateCallerMetadata(metadata).ok).toBe(true);
    expect(validateCallerMetadata({ enlitt_private: "x" }).ok).toBe(false);
  });
});

const response = (overrides: Record<string, unknown> = {}) => ({
  id: "resp_1", object: "response", created_at: 1, status: "completed", error: null,
  incomplete_details: null, model: ENLITT_STANDARD_MODEL, output: [],
  usage: { input_tokens: 2, input_tokens_details: { cached_tokens: 1 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 1 }, total_tokens: 5 },
  metadata: {}, ...overrides
});

describe("validateOpenAIResponse", () => {
  it("accepts the response and preserves usage details", () => {
    const result = validateOpenAIResponse(response());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.usage).toEqual(response().usage);
  });
  it("rejects malformed output items", () => expect(validateOpenAIResponse(response({ output: [{ type: "mystery" }] })).ok).toBe(false));

  it("drops future fields and maps future closed values in tolerant mode", () => {
    const future = response({
      status: "paused",
      future_root: true,
      output: [{ type: "future_item", data: "ignored" }],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5, future_usage: true }
    });
    expect(validateOpenAIResponse(future).ok).toBe(false);
    const tolerant = validateOpenAIResponse(future, { mode: "tolerant" });
    expect(tolerant.ok).toBe(true);
    if (tolerant.ok) {
      expect(tolerant.value.status).toBe("other");
      expect(tolerant.value.output).toEqual([{ unknown: true, type: "future_item" }]);
      expect(tolerant.value).not.toHaveProperty("future_root");
      expect(tolerant.value.usage).not.toHaveProperty("future_usage");
    }
  });

  it("rejects unknown variant discriminators longer than 64 characters in both modes", () => {
    const value = response({ output: [{ type: "x".repeat(65) }] });
    expect(validateOpenAIResponse(value).ok).toBe(false);
    expect(validateOpenAIResponse(value, { mode: "tolerant" }).ok).toBe(false);
  });
});
