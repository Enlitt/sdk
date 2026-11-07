using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.AI;

namespace Enlitt.Extensions.AI;

/// <summary>Maps <c>Microsoft.Extensions.AI</c> input to the Enlitt standard request and the result back. Pure functions; no I/O.</summary>
internal static class ChatMapping
{
  private static readonly string[] ImageTypes = ["image/png", "image/jpeg"];

  /// <summary>
  /// Reads and validates <c>ChatOptions.AdditionalProperties["enlitt"]</c>. Every failure is an
  /// <see cref="EnlittConfigurationException"/> raised before any request.
  /// </summary>
  internal static (EnlittProviderOptions Options, string? MaxCharge) ReadProviderOptions(ChatOptions? chatOptions, bool premium)
  {
    EnlittProviderOptions options = new();
    if (chatOptions?.AdditionalProperties is { } extra && extra.TryGetValue(EnlittProviderOptions.Key, out object? raw) && raw is not null)
    {
      options = raw as EnlittProviderOptions
          ?? throw new EnlittConfigurationException($"ChatOptions.AdditionalProperties[\"{EnlittProviderOptions.Key}\"] must be an {nameof(EnlittProviderOptions)}.");
    }

    if (options.IdempotencyKey is { } key)
    {
      CallValidation.IdempotencyKey(key);
    }

    CallValidation.Metadata(options.Metadata);

    if (!premium)
    {
      if (options.MaxCharge is not null || options.Price is not null || options.ReportingDeadlineMs is not null)
      {
        throw new EnlittConfigurationException("MaxCharge, Price and ReportingDeadlineMs are premium-only and are not allowed on the standard model.");
      }

      return (options, null);
    }

    if (options.ReportingDeadlineMs is { } deadline)
    {
      CallValidation.ReportingDeadline(deadline);
    }

    if (options.MaxCharge is not null)
    {
      CallValidation.Nanousd(options.MaxCharge, "MaxCharge");
    }

    string? constant = options.Price?.Constant;
    if (constant is not null)
    {
      CallValidation.Nanousd(constant, "A constant Price");
      if (options.MaxCharge is not null && Nano.Parse(constant) > Nano.Parse(options.MaxCharge))
      {
        throw new EnlittConfigurationException("A constant Price above MaxCharge could never be charged in full.");
      }
    }

    string? maxCharge = options.MaxCharge ?? constant;
    if (maxCharge is null)
    {
      throw new EnlittConfigurationException("A premium call needs MaxCharge, or a constant Price to default it from.");
    }

    return (options, maxCharge);
  }

  /// <summary>The call identity: the base (supplied or random) plus the count of messages passed to the call.</summary>
  internal static string CallId(EnlittProviderOptions options, int messageCount) =>
      (options.IdempotencyKey ?? CallValidation.NewId("enl_")) + "." + messageCount.ToString(System.Globalization.CultureInfo.InvariantCulture);

  /// <summary>Builds the standard request, refusing anything the standard model does not support.</summary>
  internal static StdRequest ToRequest(IReadOnlyList<ChatMessage> messages, ChatOptions? options, EnlittProviderOptions providerOptions, bool stream)
  {
    var mapped = new List<StdMessage>();
    if (options is not null)
    {
      RefuseUnsupported(options);
      if (!string.IsNullOrEmpty(options.Instructions))
      {
        mapped.Add(new StdSystem(options.Instructions));
      }
    }

    foreach (ChatMessage message in messages)
    {
      MapMessage(message, mapped);
    }

    IReadOnlyList<StdTool>? tools = null;
    if (options?.Tools is { Count: > 0 } declared && options.ToolMode is not NoneChatToolMode)
    {
      tools = [.. declared.Select(MapTool)];
    }

    return new StdRequest(mapped, tools, options?.MaxOutputTokens, stream, providerOptions.Metadata);
  }

  private static void RefuseUnsupported(ChatOptions options)
  {
    var refused = new List<string>();
    void Check(bool present, string name)
    {
      if (present)
      {
        refused.Add(name);
      }
    }

    Check(options.Temperature is not null, nameof(options.Temperature));
    Check(options.TopP is not null, nameof(options.TopP));
    Check(options.TopK is not null, nameof(options.TopK));
    Check(options.FrequencyPenalty is not null, nameof(options.FrequencyPenalty));
    Check(options.PresencePenalty is not null, nameof(options.PresencePenalty));
    Check(options.Seed is not null, nameof(options.Seed));
    Check(options.StopSequences is { Count: > 0 }, nameof(options.StopSequences));
    Check(options.ResponseFormat is not null and not ChatResponseFormatText, nameof(options.ResponseFormat));
    Check(options.AllowMultipleToolCalls is not null, nameof(options.AllowMultipleToolCalls));
    Check(options.RawRepresentationFactory is not null, nameof(options.RawRepresentationFactory));
    Check(options.ConversationId is not null, nameof(options.ConversationId));
    Check(options.ToolMode is RequiredChatToolMode, nameof(options.ToolMode) + " (RequireAny/RequireSpecific)");
    Check(options.ModelId is not null && options.ModelId != EnlittConstants.StandardModel, nameof(options.ModelId));
    if (refused.Count > 0)
    {
      throw new EnlittConfigurationException(
          $"The Enlitt standard model does not support: {string.Join(", ", refused)}. Nothing unsupported is dropped silently.");
    }
  }

  private static StdTool MapTool(AITool tool)
  {
    if (tool is not AIFunctionDeclaration function)
    {
      throw new EnlittConfigurationException("Only AIFunction tools are supported by the Enlitt standard model.");
    }

    JsonNode schema = JsonNode.Parse(function.JsonSchema.GetRawText()) ?? new JsonObject();
    return new StdTool(function.Name, string.IsNullOrEmpty(function.Description) ? null : function.Description, schema);
  }

  private static void MapMessage(ChatMessage message, List<StdMessage> into)
  {
    if (message.Role == ChatRole.System)
    {
      into.Add(new StdSystem(TextOnly(message)));
    }
    else if (message.Role == ChatRole.User)
    {
      var parts = new List<StdUserPart>();
      foreach (AIContent content in message.Contents)
      {
        parts.Add(content switch
        {
          TextContent text => new StdText(text.Text),
          UriContent uri when IsImage(uri.MediaType) && uri.Uri.Scheme == Uri.UriSchemeHttps => new StdImageUrl(uri.Uri.AbsoluteUri),
          DataContent data when IsImage(data.MediaType) => new StdImageBase64(data.MediaType, Convert.ToBase64String(data.Data.Span)),
          _ => throw Unsupported(content),
        });
      }

      into.Add(new StdUser(parts));
    }
    else if (message.Role == ChatRole.Assistant)
    {
      var text = new StringBuilder();
      var calls = new List<StdToolCall>();
      foreach (AIContent content in message.Contents)
      {
        switch (content)
        {
          case TextContent t:
            text.Append(t.Text);
            break;
          case FunctionCallContent call:
            calls.Add(new StdToolCall(call.CallId, call.Name, call.Arguments is null ? "{}" : JsonSerializer.Serialize(call.Arguments, AIJsonUtilities.DefaultOptions)));
            break;
          default:
            throw Unsupported(content);
        }
      }

      into.Add(new StdAssistant(text.Length > 0 ? text.ToString() : null, calls));
    }
    else if (message.Role == ChatRole.Tool)
    {
      foreach (AIContent content in message.Contents)
      {
        if (content is not FunctionResultContent result)
        {
          throw Unsupported(content);
        }

        into.Add(new StdToolResult(result.CallId, result.Result is string s ? s : JsonSerializer.Serialize(result.Result, AIJsonUtilities.DefaultOptions)));
      }
    }
    else
    {
      throw new EnlittConfigurationException($"The chat role \"{message.Role}\" is not supported by the Enlitt standard model.");
    }
  }

  private static string TextOnly(ChatMessage message)
  {
    var text = new StringBuilder();
    foreach (AIContent content in message.Contents)
    {
      text.Append(content is TextContent t ? t.Text : throw Unsupported(content));
    }

    return text.ToString();
  }

  private static bool IsImage(string? mediaType) => mediaType is not null && ImageTypes.Contains(mediaType, StringComparer.OrdinalIgnoreCase);

  private static EnlittConfigurationException Unsupported(AIContent content) =>
      new($"The content type {content.GetType().Name} is not supported by the Enlitt standard model (text, https PNG/JPEG images, function calls and results only).");

  // ---- results ----------------------------------------------------------------------------------------------

  /// <summary>Maps a unified finish reason; "error" and "other" keep their raw value.</summary>
  internal static ChatFinishReason Finish(string reason) => reason switch
  {
    "stop" => ChatFinishReason.Stop,
    "length" => ChatFinishReason.Length,
    "tool-calls" => ChatFinishReason.ToolCalls,
    "content-filter" => ChatFinishReason.ContentFilter,
    _ => new ChatFinishReason(reason),
  };

  /// <summary>Count key for cached input tokens in <see cref="UsageDetails.AdditionalCounts"/> (the convention of the other adapters).</summary>
  internal const string CachedInputKey = "InputTokenDetails.CachedTokenCount";

  /// <summary>Count key for reasoning tokens in <see cref="UsageDetails.AdditionalCounts"/>.</summary>
  internal const string ReasoningKey = "OutputTokenDetails.ReasoningTokenCount";

  internal static UsageDetails ToUsage(StdUsage usage)
  {
    var details = new UsageDetails
    {
      InputTokenCount = usage.InputTokens,
      OutputTokenCount = usage.OutputTokens,
      TotalTokenCount = usage.TotalTokens,
    };
    if (usage.CachedTokens is { } cached)
    {
      (details.AdditionalCounts ??= [])[CachedInputKey] = cached;
    }

    if (usage.ReasoningTokens is { } reasoning)
    {
      (details.AdditionalCounts ??= [])[ReasoningKey] = reasoning;
    }

    return details;
  }

  internal static long? Count(UsageDetails usage, string key) =>
      usage.AdditionalCounts is { } counts && counts.TryGetValue(key, out long value) ? value : null;

  internal static EnlittStandardMetadata ToMetadata(StdRouting routing) =>
      new(routing.OperationId, routing.RoutedProvider, routing.RoutedModel, routing.PolicyVersion);

  internal static FunctionCallContent ToCall(StdToolCall call)
  {
    try
    {
      var arguments = JsonSerializer.Deserialize<Dictionary<string, object?>>(call.Arguments, AIJsonUtilities.DefaultOptions);
      return new FunctionCallContent(call.Id, call.Name, arguments);
    }
    catch (JsonException ex)
    {
      // Malformed model arguments are surfaced on the content item, never thrown from the response.
      return new FunctionCallContent(call.Id, call.Name, null) { Exception = ex };
    }
  }

  internal static ChatResponse ToResponse(StdResult result)
  {
    var contents = new List<AIContent>();
    if (result.Text.Length > 0)
    {
      contents.Add(new TextContent(result.Text));
    }

    contents.AddRange(result.ToolCalls.Select(ToCall));
    if (result.ErrorMessage is not null)
    {
      contents.Add(new ErrorContent(result.ErrorMessage));
    }

    var response = new ChatResponse(new ChatMessage(ChatRole.Assistant, contents))
    {
      FinishReason = Finish(result.FinishReason),
      Usage = result.Usage is null ? null : ToUsage(result.Usage),
      ResponseId = result.Routing.OperationId,
      AdditionalProperties = new AdditionalPropertiesDictionary { [EnlittProviderOptions.Key] = ToMetadata(result.Routing) },
    };
    return response;
  }

  internal static ChatResponseUpdate ToUpdate(StdStreamPart part)
  {
    switch (part)
    {
      case StdTextDelta delta:
        return new ChatResponseUpdate(ChatRole.Assistant, delta.Text);
      case StdToolCallPart call:
        return new ChatResponseUpdate(ChatRole.Assistant, [ToCall(call.Call)]);
      case StdFinish finish:
        var update = new ChatResponseUpdate(ChatRole.Assistant, [])
        {
          FinishReason = Finish(finish.FinishReason),
          ResponseId = finish.Routing.OperationId,
          AdditionalProperties = new AdditionalPropertiesDictionary { [EnlittProviderOptions.Key] = ToMetadata(finish.Routing) },
        };
        if (finish.Usage is not null)
        {
          update.Contents.Add(new UsageContent(ToUsage(finish.Usage)));
        }

        if (finish.ErrorMessage is not null)
        {
          update.Contents.Add(new ErrorContent(finish.ErrorMessage));
        }

        return update;
      default:
        throw new InvalidOperationException("Unknown standard stream part.");
    }
  }
}
