using System.Numerics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Enlitt;

/// <summary>Canonical NANOUSD integer strings and their exact arithmetic.</summary>
internal static partial class Nano
{
  /// <summary>The protocol's cap on the digits of a charge.</summary>
  internal const int MaxDigits = 30;

  [GeneratedRegex("^(0|[1-9][0-9]*)$")]
  private static partial Regex CanonicalPattern();

  /// <summary>True for a canonical nonnegative base-10 integer: no sign, fraction, exponent or noncanonical leading zero.</summary>
  internal static bool IsCanonical(string? value) => value is not null && CanonicalPattern().IsMatch(value);

  /// <summary>True for a canonical amount of at most <see cref="MaxDigits"/> digits (the charge bound).</summary>
  internal static bool IsCanonicalCharge(string? value) => IsCanonical(value) && value!.Length <= MaxDigits;

  /// <summary>Parses a canonical amount into a <see cref="BigInteger"/> without precision loss.</summary>
  internal static BigInteger Parse(string value) => BigInteger.Parse(value, System.Globalization.CultureInfo.InvariantCulture);

  /// <summary>Returns the smaller of two canonical amounts, as a canonical string.</summary>
  internal static string Min(string a, string b) => Parse(a) <= Parse(b) ? a : b;
}

/// <summary>
/// A hand-written, schema-driven tolerant reader over <see cref="JsonNode"/>. It keeps known fields of the right type,
/// drops unknown fields, reads an unknown closed-set member as <c>"other"</c>, represents an unknown variant as
/// <c>{ "unknown": true, "type": "..." }</c>, and fails with <c>malformed_response</c> on a wrongly typed known field.
/// The result is a fresh normalized tree, so callers read only fields the schema vouches for.
/// </summary>
internal abstract class Shape
{
  /// <summary>Reads <paramref name="node"/>; <paramref name="path"/> names the location in error messages.</summary>
  internal abstract JsonNode? Read(JsonNode? node, string path);

  /// <summary>Raises the malformed-response failure for a wrongly typed field.</summary>
  protected static EnlittException Wrong(string path, string expected) =>
      EnlittErrors.Malformed($"The Enlitt response field \"{path}\" is not {expected}.");

  /// <summary>A string, optionally bounded, optionally a closed-set member, optionally exactly one literal, optionally canonical NANOUSD.</summary>
  internal static Shape Str(int maxLength = 4096, string? closedSet = null, string? exact = null, bool nano = false) =>
      new StringShape(maxLength, closedSet, exact, nano);

  /// <summary>An integer.</summary>
  internal static readonly Shape Int = new IntegerShape();

  /// <summary>A boolean.</summary>
  internal static readonly Shape Bool = new BooleanShape();

  /// <summary>Any JSON value, passed through untouched (metadata values that are objects, JSON schema, ...).</summary>
  internal static readonly Shape Any = new AnyShape();

  /// <summary>An object whose values are all strings.</summary>
  internal static readonly Shape StringMap = new StringMapShape();

  /// <summary>An array whose every element reads as <paramref name="item"/>.</summary>
  internal static Shape Array(Shape item) => new ArrayShape(item);

  /// <summary>An object with the named fields.</summary>
  internal static ObjectShape Obj(params (string Name, Shape Shape, Presence Presence)[] fields) => new(fields);

  /// <summary>A discriminated union keyed by <c>type</c>; an unlisted type reads as an unknown variant.</summary>
  internal static Shape Variant(params (string Type, ObjectShape Shape)[] members) => new VariantShape(members);

  /// <summary>Whether a field must be present, may be absent, or may be null.</summary>
  internal enum Presence
  {
    /// <summary>The field is required and non-null.</summary>
    Required,

    /// <summary>The field may be absent but, when present, is non-null.</summary>
    Optional,

    /// <summary>The field is required but may be null.</summary>
    Nullable,
  }

  private sealed class StringShape(int maxLength, string? closedSet, string? exact, bool nano) : Shape
  {
    internal override JsonNode? Read(JsonNode? node, string path)
    {
      if (node is not JsonValue value || !value.TryGetValue(out string? text))
      {
        throw Wrong(path, "a string");
      }

      if (exact is not null)
      {
        return text == exact ? JsonValue.Create(text) : throw Wrong(path, $"\"{exact}\"");
      }

      if (closedSet is not null)
      {
        return JsonValue.Create(EnlittContract.ReadMember(closedSet, text));
      }

      if (nano && !Nano.IsCanonicalCharge(text))
      {
        throw Wrong(path, "a canonical NANOUSD integer string");
      }

      return text.Length <= maxLength ? JsonValue.Create(text) : throw Wrong(path, "a string within its size bound");
    }
  }

  private sealed class IntegerShape : Shape
  {
    internal override JsonNode? Read(JsonNode? node, string path) =>
        node is JsonValue value && value.TryGetValue(out long number) ? JsonValue.Create(number) : throw Wrong(path, "an integer");
  }

  private sealed class BooleanShape : Shape
  {
    internal override JsonNode? Read(JsonNode? node, string path) =>
        node is JsonValue value && value.TryGetValue(out bool flag) ? JsonValue.Create(flag) : throw Wrong(path, "a boolean");
  }

  private sealed class AnyShape : Shape
  {
    internal override JsonNode? Read(JsonNode? node, string path) => node?.DeepClone();
  }

  private sealed class StringMapShape : Shape
  {
    internal override JsonNode? Read(JsonNode? node, string path)
    {
      if (node is not JsonObject obj)
      {
        throw Wrong(path, "an object");
      }

      var result = new JsonObject();
      foreach (KeyValuePair<string, JsonNode?> entry in obj)
      {
        if (entry.Value is not JsonValue value || !value.TryGetValue(out string? text))
        {
          throw Wrong($"{path}.{entry.Key}", "a string");
        }

        result[entry.Key] = text;
      }

      return result;
    }
  }

  private sealed class ArrayShape(Shape item) : Shape
  {
    internal override JsonNode? Read(JsonNode? node, string path)
    {
      if (node is not JsonArray array)
      {
        throw Wrong(path, "an array");
      }

      var result = new JsonArray();
      for (int i = 0; i < array.Count; i++)
      {
        result.Add(item.Read(array[i], $"{path}[{i}]"));
      }

      return result;
    }
  }

  internal sealed class ObjectShape(IReadOnlyList<(string Name, Shape Shape, Presence Presence)> fields) : Shape
  {
    internal override JsonNode? Read(JsonNode? node, string path)
    {
      if (node is not JsonObject obj)
      {
        throw Wrong(path, "an object");
      }

      var result = new JsonObject();
      foreach ((string name, Shape shape, Presence presence) in fields)
      {
        string fieldPath = path.Length == 0 ? name : $"{path}.{name}";
        bool present = obj.TryGetPropertyValue(name, out JsonNode? raw);
        if (!present)
        {
          if (presence == Presence.Optional)
          {
            continue;
          }

          throw EnlittErrors.Malformed($"The Enlitt response is missing the field \"{fieldPath}\".");
        }

        if (raw is null)
        {
          result[name] = presence == Presence.Nullable ? null : throw Wrong(fieldPath, "non-null");
          continue;
        }

        result[name] = shape.Read(raw, fieldPath);
      }

      return result;
    }
  }

  private sealed class VariantShape(IReadOnlyList<(string Type, ObjectShape Shape)> members) : Shape
  {
    internal override JsonNode? Read(JsonNode? node, string path)
    {
      if (node is not JsonObject obj || obj["type"] is not JsonValue typeValue || !typeValue.TryGetValue(out string? type))
      {
        throw Wrong(path, "an object with a string type");
      }

      foreach ((string memberType, ObjectShape shape) in members)
      {
        if (memberType == type)
        {
          return shape.Read(node, path);
        }
      }

      return Unknown(type);
    }
  }

  /// <summary>Builds the <c>UnknownVariant</c> representation: <c>{ "unknown": true, "type": &lt;at most 64 characters&gt; }</c>.</summary>
  internal static JsonObject Unknown(string type) =>
      new() { ["unknown"] = true, ["type"] = type.Length <= 64 ? type : type[..64] };

  /// <summary>True when <paramref name="node"/> is the unknown-variant representation.</summary>
  internal static bool IsUnknown(JsonNode? node) => node is JsonObject o && o["unknown"] is JsonValue v && v.TryGetValue(out bool b) && b;
}

/// <summary>The tolerant shapes of every response the SDK reads, and the entry points that parse a body with them.</summary>
internal static class WireShapes
{
  private const Shape.Presence Req = Shape.Presence.Required;
  private const Shape.Presence Opt = Shape.Presence.Optional;
  private const Shape.Presence Nul = Shape.Presence.Nullable;

  private static readonly Shape.ObjectShape OutputText = Shape.Obj(("type", Shape.Str(exact: "output_text"), Req), ("text", Shape.Str(int.MaxValue), Req));

  private static readonly Shape.ObjectShape Message = Shape.Obj(
      ("type", Shape.Str(exact: "message"), Req),
      ("id", Shape.Str(), Req),
      ("role", Shape.Str(exact: "assistant"), Req),
      ("status", Shape.Str(closedSet: "response.output_item.status"), Req),
      ("content", Shape.Array(Shape.Variant(("output_text", OutputText))), Req));

  private static readonly Shape.ObjectShape FunctionCall = Shape.Obj(
      ("type", Shape.Str(exact: "function_call"), Req),
      ("id", Shape.Str(), Req),
      ("call_id", Shape.Str(), Req),
      ("name", Shape.Str(), Req),
      ("arguments", Shape.Str(int.MaxValue), Req),
      ("status", Shape.Str(closedSet: "response.output_item.status"), Req));

  private static readonly Shape OutputItem = Shape.Variant(("message", Message), ("function_call", FunctionCall));

  private static readonly Shape.ObjectShape Usage = Shape.Obj(
      ("input_tokens", Shape.Int, Req),
      ("input_tokens_details", Shape.Obj(("cached_tokens", Shape.Int, Opt)), Opt),
      ("output_tokens", Shape.Int, Req),
      ("output_tokens_details", Shape.Obj(("reasoning_tokens", Shape.Int, Opt)), Opt),
      ("total_tokens", Shape.Int, Req));

  /// <summary>The non-streaming response body and the <c>response</c> object nested in stream events.</summary>
  internal static readonly Shape.ObjectShape Response = Shape.Obj(
      ("id", Shape.Str(), Req),
      ("object", Shape.Str(exact: "response"), Req),
      ("created_at", Shape.Int, Req),
      ("completed_at", Shape.Int, Opt),
      ("status", Shape.Str(closedSet: "response.status"), Req),
      ("error", Shape.Obj(("code", Shape.Str(), Req), ("message", Shape.Str(int.MaxValue), Req)), Nul),
      ("incomplete_details", Shape.Obj(("reason", Shape.Str(closedSet: "response.incomplete_details.reason"), Req)), Nul),
      ("model", Shape.Str(exact: EnlittConstants.StandardModel), Req),
      ("output", Shape.Array(OutputItem), Req),
      ("output_text", Shape.Str(int.MaxValue), Opt),
      ("usage", Usage, Opt),
      ("metadata", Shape.StringMap, Req));

  /// <summary>The begin-operation response.</summary>
  internal static readonly Shape.ObjectShape BeginOperation = Shape.Obj(
      ("operation_id", Shape.Str(), Req),
      ("billing", Shape.Str(closedSet: "premium_operation.billing"), Req),
      ("report_terminal", Shape.Bool, Req),
      ("effective_max_charge_nano_usd", Shape.Str(nano: true), Req),
      ("reserved_nano_usd", Shape.Str(nano: true), Req),
      ("terminal_deadline", Shape.Str(), Req));

  /// <summary>The terminal-report response.</summary>
  internal static readonly Shape.ObjectShape ReportTerminal = Shape.Obj(
      ("operation_id", Shape.Str(), Req),
      ("status", Shape.Str(closedSet: "premium_terminal.status"), Req),
      ("idempotent_replay", Shape.Bool, Req),
      ("settlement", Shape.Obj(
          ("captured_nano_usd", Shape.Str(nano: true), Req),
          ("released_nano_usd", Shape.Str(nano: true), Req),
          ("business_earnings_nano_usd", Shape.Str(nano: true), Req)), Opt));

  private static readonly Shape.ObjectShape Availability = Shape.Obj(
      ("remaining_percent", Shape.Int, Req),
      ("limit_cap_nano_usd", Shape.Str(nano: true), Req));

  /// <summary>The <c>GET /v1/enlitt/usage</c> response.</summary>
  internal static readonly Shape.ObjectShape UsageResponse = Shape.Obj(("standard", Availability, Req), ("premium", Availability, Req));

  /// <summary>The authorization-code exchange response.</summary>
  internal static readonly Shape.ObjectShape CodeExchange = Shape.Obj(
      ("session_token", Shape.Str(EnlittSession.MaxTokenLength), Req),
      ("subject", Shape.Str(255), Req));

  private static Shape.ObjectShape Event(string type, params (string Name, Shape Shape, Shape.Presence Presence)[] more) =>
      Shape.Obj([("type", Shape.Str(exact: type), Req), ("sequence_number", Shape.Int, Req), .. more]);

  private static readonly (string Name, Shape Shape, Shape.Presence Presence)[] ItemIndex =
  [
      ("item_id", Shape.Str(), Req),
        ("output_index", Shape.Int, Req),
    ];

  /// <summary>The stream-event union; a type outside it reads as an unknown event that still carries its sequence number.</summary>
  internal static readonly Shape.ObjectShape[] StreamEvents =
  [
      Event("response.created", ("response", Response, Req)),
        Event("response.in_progress", ("response", Response, Req)),
        Event("response.completed", ("response", Response, Req)),
        Event("response.incomplete", ("response", Response, Req)),
        Event("response.failed", ("response", Response, Req)),
        Event("response.output_item.added", ("output_index", Shape.Int, Req), ("item", OutputItem, Req)),
        Event("response.output_item.done", ("output_index", Shape.Int, Req), ("item", OutputItem, Req)),
        Event("response.content_part.added", [.. ItemIndex, ("content_index", Shape.Int, Req), ("part", Shape.Variant(("output_text", OutputText)), Req)]),
        Event("response.content_part.done", [.. ItemIndex, ("content_index", Shape.Int, Req), ("part", Shape.Variant(("output_text", OutputText)), Req)]),
        Event("response.output_text.delta", [.. ItemIndex, ("content_index", Shape.Int, Req), ("delta", Shape.Str(int.MaxValue), Req)]),
        Event("response.output_text.done", [.. ItemIndex, ("content_index", Shape.Int, Req), ("text", Shape.Str(int.MaxValue), Req)]),
        Event("response.function_call_arguments.delta", [.. ItemIndex, ("delta", Shape.Str(int.MaxValue), Req)]),
        Event("response.function_call_arguments.done", [.. ItemIndex, ("arguments", Shape.Str(int.MaxValue), Req)]),
    ];

  /// <summary>Parses one stream-event payload. Unknown types read as <c>{ unknown, type, sequence_number }</c>.</summary>
  internal static JsonObject ReadStreamEvent(JsonNode? node)
  {
    if (node is not JsonObject obj || obj["type"] is not JsonValue typeValue || !typeValue.TryGetValue(out string? type))
    {
      throw EnlittErrors.Malformed("A stream event is not an object with a string type.");
    }

    if (obj["sequence_number"] is not JsonValue sequenceValue || !sequenceValue.TryGetValue(out long sequence))
    {
      throw EnlittErrors.Malformed("A stream event has no integer sequence_number.");
    }

    foreach (Shape.ObjectShape shape in StreamEvents)
    {
      // Each event shape pins its own `type`; try the matching one only.
      if (EventType(shape) == type)
      {
        return (JsonObject)shape.Read(node, "event")!;
      }
    }

    JsonObject unknown = Shape.Unknown(type);
    unknown["sequence_number"] = sequence;
    return unknown;
  }

  private static readonly Dictionary<Shape.ObjectShape, string> EventTypes = BuildEventTypes();

  private static Dictionary<Shape.ObjectShape, string> BuildEventTypes()
  {
    string[] names =
    [
        "response.created", "response.in_progress", "response.completed", "response.incomplete", "response.failed",
            "response.output_item.added", "response.output_item.done", "response.content_part.added", "response.content_part.done",
            "response.output_text.delta", "response.output_text.done", "response.function_call_arguments.delta",
            "response.function_call_arguments.done",
        ];
    var map = new Dictionary<Shape.ObjectShape, string>(ReferenceEqualityComparer.Instance);
    for (int i = 0; i < names.Length; i++)
    {
      map[StreamEvents[i]] = names[i];
    }

    return map;
  }

  private static string EventType(Shape.ObjectShape shape) => EventTypes[shape];

  /// <summary>Parses <paramref name="text"/> as JSON and reads it with <paramref name="shape"/>; any failure is <c>malformed_response</c>.</summary>
  internal static JsonObject ReadBody(Shape.ObjectShape shape, string text, string what)
  {
    JsonNode? parsed;
    try
    {
      parsed = JsonNode.Parse(text);
    }
    catch (JsonException ex)
    {
      throw EnlittErrors.Malformed($"The Enlitt {what} is not valid JSON.", ex);
    }

    return (JsonObject)shape.Read(parsed, string.Empty)!;
  }
}
