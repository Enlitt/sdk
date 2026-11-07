using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Enlitt;

// Framework-neutral view of the standard wire: the adapter maps its own types onto these, and this file maps these
// onto the JSON request and the JSON/SSE response. Nothing here knows Microsoft.Extensions.AI.

/// <summary>One part of a user message.</summary>
internal abstract record StdUserPart;

/// <summary>Text.</summary>
internal sealed record StdText(string Text) : StdUserPart;

/// <summary>An image by absolute https URL.</summary>
internal sealed record StdImageUrl(string Url) : StdUserPart;

/// <summary>An image by base64 bytes.</summary>
internal sealed record StdImageBase64(string MediaType, string Data) : StdUserPart;

/// <summary>An assistant tool call; <c>Arguments</c> is the model-produced JSON text.</summary>
internal sealed record StdToolCall(string Id, string Name, string Arguments);

/// <summary>An ordered standard message.</summary>
internal abstract record StdMessage;

/// <summary>A system message.</summary>
internal sealed record StdSystem(string Content) : StdMessage;

/// <summary>A user message.</summary>
internal sealed record StdUser(IReadOnlyList<StdUserPart> Parts) : StdMessage;

/// <summary>An assistant message with text, tool calls, or both.</summary>
internal sealed record StdAssistant(string? Content, IReadOnlyList<StdToolCall> ToolCalls) : StdMessage;

/// <summary>A tool result.</summary>
internal sealed record StdToolResult(string ToolCallId, string Content) : StdMessage;

/// <summary>A function tool.</summary>
internal sealed record StdTool(string Name, string? Description, JsonNode InputSchema);

/// <summary>One standard request.</summary>
internal sealed record StdRequest(
    IReadOnlyList<StdMessage> Messages,
    IReadOnlyList<StdTool>? Tools,
    int? MaxOutputTokens,
    bool Stream,
    IReadOnlyDictionary<string, string>? Metadata);

/// <summary>Exact token counts.</summary>
internal sealed record StdUsage(long InputTokens, long OutputTokens, long TotalTokens, long? CachedTokens, long? ReasoningTokens);

/// <summary>The safe routing facts Enlitt returns in reserved metadata keys; nothing else is exposed.</summary>
internal sealed record StdRouting(string? OperationId, string? RoutedProvider, string? RoutedModel, string? PolicyVersion);

/// <summary>A non-streaming result.</summary>
internal sealed record StdResult(
    string Text,
    IReadOnlyList<StdToolCall> ToolCalls,
    string FinishReason,
    StdUsage? Usage,
    StdRouting Routing,
    IReadOnlyList<string> UnknownItemTypes,
    string? ErrorMessage);

/// <summary>One part of a mapped stream.</summary>
internal abstract record StdStreamPart;

/// <summary>An incremental text delta.</summary>
internal sealed record StdTextDelta(string Text) : StdStreamPart;

/// <summary>A complete function call.</summary>
internal sealed record StdToolCallPart(StdToolCall Call) : StdStreamPart;

/// <summary>The one terminal part.</summary>
internal sealed record StdFinish(string FinishReason, StdUsage? Usage, StdRouting Routing, string? ErrorMessage) : StdStreamPart;

/// <summary>Request builder, response mapper and stream mapper for the standard route.</summary>
internal static class StandardWire
{
  private const int MaxTools = 64;
  private const int MaxImages = 16;

  /// <summary>Builds the request body, refusing locally what the wire cannot carry.</summary>
  internal static JsonObject BuildRequest(StdRequest request)
  {
    if (request.Messages.Count == 0)
    {
      throw new EnlittConfigurationException("An Enlitt request needs at least one message.");
    }

    int images = 0;
    var messages = new JsonArray();
    foreach (StdMessage message in request.Messages)
    {
      switch (message)
      {
        case StdSystem system:
          messages.Add(new JsonObject { ["role"] = "system", ["content"] = system.Content });
          break;
        case StdUser user:
          var parts = new JsonArray();
          foreach (StdUserPart part in user.Parts)
          {
            parts.Add(BuildUserPart(part, ref images));
          }

          messages.Add(new JsonObject { ["role"] = "user", ["content"] = parts });
          break;
        case StdAssistant assistant:
          if (assistant.Content is null && assistant.ToolCalls.Count == 0)
          {
            throw new EnlittConfigurationException("An assistant message needs text or a tool call.");
          }

          var wireAssistant = new JsonObject { ["role"] = "assistant" };
          if (assistant.Content is not null)
          {
            wireAssistant["content"] = assistant.Content;
          }

          if (assistant.ToolCalls.Count > 0)
          {
            wireAssistant["tool_calls"] = new JsonArray(assistant.ToolCalls
                .Select(c => (JsonNode)new JsonObject { ["id"] = c.Id, ["name"] = c.Name, ["arguments"] = c.Arguments }).ToArray());
          }

          messages.Add(wireAssistant);
          break;
        case StdToolResult tool:
          messages.Add(new JsonObject { ["role"] = "tool", ["tool_call_id"] = tool.ToolCallId, ["content"] = tool.Content });
          break;
        default:
          throw new EnlittConfigurationException("Unsupported message type.");
      }
    }

    if (images > MaxImages)
    {
      throw new EnlittConfigurationException($"An Enlitt request carries at most {MaxImages} images.");
    }

    var body = new JsonObject
    {
      ["model"] = EnlittConstants.StandardModel,
      ["messages"] = messages,
    };

    if (request.Tools is { Count: > 0 } tools)
    {
      if (tools.Count > MaxTools)
      {
        throw new EnlittConfigurationException($"An Enlitt request carries at most {MaxTools} tools.");
      }

      body["tools"] = new JsonArray(tools.Select(t =>
      {
        var tool = new JsonObject { ["name"] = t.Name };
        if (t.Description is not null)
        {
          tool["description"] = t.Description;
        }

        tool["input_schema"] = t.InputSchema.DeepClone();
        return (JsonNode)tool;
      }).ToArray());
    }

    if (request.MaxOutputTokens is { } max)
    {
      if (max < 1)
      {
        throw new EnlittConfigurationException("MaxOutputTokens must be positive.");
      }

      body["max_output_tokens"] = max;
    }

    if (request.Stream)
    {
      body["stream"] = true;
    }

    CallValidation.Metadata(request.Metadata);
    if (request.Metadata is { Count: > 0 } metadata)
    {
      var map = new JsonObject();
      foreach ((string key, string value) in metadata)
      {
        map[key] = value;
      }

      body["metadata"] = map;
    }

    return body;
  }

  private static JsonNode BuildUserPart(StdUserPart part, ref int images)
  {
    switch (part)
    {
      case StdText text:
        if (text.Text.Length == 0)
        {
          throw new EnlittConfigurationException("Empty text is not accepted.");
        }

        return new JsonObject { ["type"] = "text", ["text"] = text.Text };
      case StdImageUrl url:
        images++;
        if (!Uri.TryCreate(url.Url, UriKind.Absolute, out Uri? uri) || uri.Scheme != Uri.UriSchemeHttps)
        {
          throw new EnlittConfigurationException("An image URL must be an absolute https URL.");
        }

        return new JsonObject { ["type"] = "image", ["source"] = new JsonObject { ["type"] = "url", ["url"] = url.Url } };
      case StdImageBase64 data:
        images++;
        if (data.MediaType is not ("image/png" or "image/jpeg"))
        {
          throw new EnlittConfigurationException("Image bytes must be image/png or image/jpeg.");
        }

        return new JsonObject
        {
          ["type"] = "image",
          ["source"] = new JsonObject { ["type"] = "base64", ["media_type"] = data.MediaType, ["data"] = data.Data },
        };
      default:
        throw new EnlittConfigurationException("Unsupported user content part.");
    }
  }

  /// <summary>Maps a tolerant-parsed non-streaming response.</summary>
  internal static StdResult MapResponse(JsonObject response)
  {
    var text = new System.Text.StringBuilder();
    var calls = new List<StdToolCall>();
    var unknown = new List<string>();

    foreach (JsonNode? item in response["output"]!.AsArray())
    {
      if (Shape.IsUnknown(item))
      {
        string type = item!["type"]!.GetValue<string>();
        if (!unknown.Contains(type))
        {
          unknown.Add(type);
        }

        continue;
      }

      switch (item!["type"]!.GetValue<string>())
      {
        case "message":
          foreach (JsonNode? part in item["content"]!.AsArray())
          {
            if (!Shape.IsUnknown(part))
            {
              text.Append(part!["text"]!.GetValue<string>());
            }
          }

          break;
        case "function_call":
          calls.Add(new StdToolCall(
              item["call_id"]!.GetValue<string>(),
              item["name"]!.GetValue<string>(),
              item["arguments"]!.GetValue<string>()));
          break;
      }
    }

    string status = response["status"]!.GetValue<string>();
    return new StdResult(
        text.ToString(),
        calls,
        FinishFor(status, calls.Count > 0),
        ReadUsage(response["usage"]),
        ReadRouting(response["metadata"]),
        unknown,
        response["error"]?["message"]?.GetValue<string>());
  }

  /// <summary>The unified finish reason for a response status. An unknown or non-final status is "other", never "stop".</summary>
  internal static string FinishFor(string status, bool sawFunctionCall) => status switch
  {
    "completed" => sawFunctionCall ? "tool-calls" : "stop",
    "incomplete" => "length",
    "failed" => "error",
    _ => "other",
  };

  private static StdUsage? ReadUsage(JsonNode? usage) => usage is null
      ? null
      : new StdUsage(
          usage["input_tokens"]!.GetValue<long>(),
          usage["output_tokens"]!.GetValue<long>(),
          usage["total_tokens"]!.GetValue<long>(),
          usage["input_tokens_details"]?["cached_tokens"]?.GetValue<long>(),
          usage["output_tokens_details"]?["reasoning_tokens"]?.GetValue<long>());

  private static StdRouting ReadRouting(JsonNode? metadata) => new(
      metadata?["enlitt_operation_id"]?.GetValue<string>(),
      metadata?["enlitt_routed_provider"]?.GetValue<string>(),
      metadata?["enlitt_routed_model"]?.GetValue<string>(),
      metadata?["enlitt_policy_version"]?.GetValue<string>());

  /// <summary>
  /// Maps SSE events to parts. Enforces: each payload parses against the stream schemas; sequence numbers rise by exactly
  /// one (an identical repeat of the last event is dropped); unknown events are skipped but count toward the sequence;
  /// exactly one terminal event ends the stream and nothing follows it; a stream with no terminal event is malformed.
  /// </summary>
  internal static async IAsyncEnumerable<StdStreamPart> MapStreamAsync(
      IAsyncEnumerable<SseEvent> events,
      [EnumeratorCancellation] CancellationToken cancellationToken = default)
  {
    long? previous = null;
    string? previousRaw = null;
    bool terminal = false;
    bool sawFunctionCall = false;
    StdRouting routing = new(null, null, null, null);
    var calls = new Dictionary<long, PendingCall>();

    await foreach (SseEvent sse in events.WithCancellation(cancellationToken).ConfigureAwait(false))
    {
      if (terminal)
      {
        throw EnlittErrors.Malformed("The Enlitt stream sent data after its terminal event.");
      }

      JsonObject evt = ParseEvent(sse.Data, out long sequence);
      string canonical = Canonical.Serialize(evt);

      if (previous is { } last)
      {
        if (sequence == last)
        {
          if (canonical == previousRaw)
          {
            continue; // an identical repeat of the last event is tolerated and dropped
          }

          throw EnlittErrors.Malformed("The Enlitt stream repeated a sequence number with different content.");
        }

        if (sequence != last + 1)
        {
          throw EnlittErrors.Malformed("The Enlitt stream skipped or reordered a sequence number.");
        }
      }

      previous = sequence;
      previousRaw = canonical;

      if (Shape.IsUnknown(evt))
      {
        continue;
      }

      switch (evt["type"]!.GetValue<string>())
      {
        case "response.created":
          routing = Merge(routing, ReadRouting(evt["response"]!["metadata"]));
          break;
        case "response.output_item.added":
          JsonNode? added = evt["item"];
          if (!Shape.IsUnknown(added) && added!["type"]!.GetValue<string>() == "function_call")
          {
            calls[evt["output_index"]!.GetValue<long>()] = new PendingCall(added["call_id"]!.GetValue<string>(), added["name"]!.GetValue<string>());
            sawFunctionCall = true;
          }

          break;
        case "response.output_text.delta":
          yield return new StdTextDelta(evt["delta"]!.GetValue<string>());
          break;
        case "response.function_call_arguments.delta":
          if (calls.TryGetValue(evt["output_index"]!.GetValue<long>(), out PendingCall? pending))
          {
            pending.Arguments.Append(evt["delta"]!.GetValue<string>());
          }

          break;
        case "response.function_call_arguments.done":
          if (calls.TryGetValue(evt["output_index"]!.GetValue<long>(), out PendingCall? done) && !done.Emitted)
          {
            done.Emitted = true;
            yield return new StdToolCallPart(new StdToolCall(done.CallId, done.Name, evt["arguments"]!.GetValue<string>()));
          }

          break;
        case "response.completed" or "response.incomplete" or "response.failed":
          terminal = true;
          foreach (PendingCall left in calls.Values.Where(c => !c.Emitted))
          {
            left.Emitted = true;
            yield return new StdToolCallPart(new StdToolCall(left.CallId, left.Name, left.Arguments.ToString()));
          }

          JsonNode response = evt["response"]!;
          yield return new StdFinish(
              FinishFor(response["status"]!.GetValue<string>(), sawFunctionCall),
              ReadUsage(response["usage"]),
              Merge(routing, ReadRouting(response["metadata"])),
              response["error"]?["message"]?.GetValue<string>());
          break;
      }
    }

    if (!terminal)
    {
      throw EnlittErrors.Malformed("The Enlitt stream ended without a terminal event.");
    }
  }

  private static StdRouting Merge(StdRouting a, StdRouting b) => new(
      b.OperationId ?? a.OperationId,
      b.RoutedProvider ?? a.RoutedProvider,
      b.RoutedModel ?? a.RoutedModel,
      b.PolicyVersion ?? a.PolicyVersion);

  private static JsonObject ParseEvent(string data, out long sequence)
  {
    JsonNode? node;
    try
    {
      node = JsonNode.Parse(data);
    }
    catch (JsonException ex)
    {
      throw EnlittErrors.Malformed("A stream event is not valid JSON.", ex);
    }

    JsonObject evt = WireShapes.ReadStreamEvent(node);
    sequence = evt["sequence_number"]!.GetValue<long>();
    return evt;
  }

  private sealed class PendingCall(string callId, string name)
  {
    internal string CallId { get; } = callId;

    internal string Name { get; } = name;

    internal System.Text.StringBuilder Arguments { get; } = new();

    internal bool Emitted { get; set; }
  }
}

/// <summary>Sends standard requests through the managed transport and maps the answers.</summary>
internal static class StandardClient
{
  /// <summary>One non-streaming call.</summary>
  internal static async Task<StdResult> GenerateAsync(InternalClient client, StdRequest request, string callId, CancellationToken cancellationToken)
  {
    CallValidation.CallId(callId);
    string body = Canonical.Serialize(StandardWire.BuildRequest(request with { Stream = false }));
    using HttpResponseMessage response = await client
        .SendAsync(new EnlittRequest(HttpMethod.Post, "/v1/responses", body, callId, "application/json"), cancellationToken)
        .ConfigureAwait(false);
    string text = await InternalClient.ReadSuccessBodyAsync(response, cancellationToken).ConfigureAwait(false);
    return StandardWire.MapResponse(WireShapes.ReadBody(WireShapes.Response, text, "response"));
  }

  /// <summary>One streaming call. The HTTP request is aborted when enumeration stops or the token fires.</summary>
  internal static async IAsyncEnumerable<StdStreamPart> StreamAsync(
      InternalClient client,
      StdRequest request,
      string callId,
      [EnumeratorCancellation] CancellationToken cancellationToken = default)
  {
    CallValidation.CallId(callId);
    string body = Canonical.Serialize(StandardWire.BuildRequest(request with { Stream = true }));
    using HttpResponseMessage response = await client
        .SendAsync(new EnlittRequest(HttpMethod.Post, "/v1/responses", body, callId, "text/event-stream"), cancellationToken)
        .ConfigureAwait(false);
    await using Stream stream = await InternalClient.OpenStreamAsync(response, cancellationToken).ConfigureAwait(false);
    await foreach (StdStreamPart part in StandardWire.MapStreamAsync(SseReader.ReadAsync(stream, cancellationToken), cancellationToken).ConfigureAwait(false))
    {
      yield return part;
    }
  }
}
