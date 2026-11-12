import { registerBoundedText, boundedTextEnabled, prepareBoundedText, boundedTextFetch, boundedHTTPFailure, boundedMissingCredential } from "../BoundedText.js";
import type {
  XAIContentPart,
  XAIInput,
  XAIMessage,
  XAIProvider,
  XAIResult,
  XAIToolCall,
  XAIToolChoice,
  XAIToolDefinition,
  XAIFinishReason
} from "@xpell/node";

import { _xu, normalizeXAIInput } from "@xpell/node";

const OPENAI_ENDPOINT =
  "https://api.openai.com/v1";

type Dict =
  Record<string, unknown>;

export type OpenAIProviderConfig = {
  apiKey: string;
  model?: string;
  endpoint?: string;
  temperature?: number;
  /** Explicit audited text-only mode. Default adapters retain their existing behavior. */
  _bounded_text?: { _transport?: typeof fetch };
};

type OpenAIChatMessage =
  | {
    role: "system" | "user";
    content: string | OpenAIChatContentPart[];
  }
  | {
    role: "assistant";
    content: string | OpenAIChatContentPart[] | null;
    tool_calls?: OpenAIToolCall[];
  }
  | {
    role: "tool";
    tool_call_id: string;
    content: string;
  };

type OpenAIToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type OpenAIChatContentPart =
  | {
    type: "text";
    text: string;
  }
  | {
    type: "image_url";
    image_url: {
      url: string;
    };
  };

const is_plain_object =
  (_xu as any).is_plain_object as (value: unknown) => value is Dict;

function ensure_optional_string(
  value: unknown
): string | undefined {

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed =
    value.trim();

  return trimmed.length > 0
    ? trimmed
    : undefined;
}

function normalize_endpoint(
  value: string
): string {

  const endpoint =
    ensure_optional_string(value);

  if (!endpoint) {
    return "";
  }

  return endpoint.endsWith("/")
    ? endpoint.slice(0, -1)
    : endpoint;
}

function sanitize_connection_error(
  err: unknown
): string {

  const message =
    err instanceof Error
      ? err.message
      : String(err);

  return message.replace(
    /[A-Za-z0-9_-]{20,}/g,
    "[redacted]"
  );
}

function extract_chat_text(
  raw: any
): string | undefined {

  if (!is_plain_object(raw)) {
    return undefined;
  }

  const choices =
    Array.isArray(raw.choices)
      ? raw.choices
      : [];

  if (choices.length === 0) {
    return undefined;
  }

  const first =
    is_plain_object(choices[0])
      ? choices[0]
      : {};

  const message =
    is_plain_object(first.message)
      ? first.message
      : {};

  const content =
    message.content;

  if (
    typeof content === "string" &&
    content.trim().length > 0
  ) {

    return content.trim();
  }

  if (Array.isArray(content)) {

    const parts: string[] = [];

    for (const part of content) {

      if (!is_plain_object(part)) {
        continue;
      }

      if (
        typeof part.text === "string" &&
        part.text.trim().length > 0
      ) {

        parts.push(
          part.text.trim()
        );
      }
    }

    if (parts.length > 0) {

      return parts.join("\n");
    }
  }

  return undefined;
}

function extract_usage(
  raw: any
) {
  if (!is_plain_object(raw)) {
    return undefined;
  }

  const usage =
    is_plain_object(raw.usage)
      ? raw.usage
      : undefined;

  if (!usage) {
    return undefined;
  }

  return {
    input_tokens:
      typeof usage.prompt_tokens === "number"
        ? usage.prompt_tokens
        : undefined,

    output_tokens:
      typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : undefined,

    total_tokens:
      typeof usage.total_tokens === "number"
        ? usage.total_tokens
        : undefined
  };
}

function extract_tool_calls(
  raw: any
): XAIToolCall[] {
  const choices = is_plain_object(raw) && Array.isArray(raw.choices)
    ? raw.choices
    : [];
  const first = is_plain_object(choices[0]) ? choices[0] : {};
  const message = is_plain_object(first.message) ? first.message : {};
  const raw_calls = Array.isArray(message.tool_calls)
    ? message.tool_calls
    : [];

  return raw_calls.map((raw_call: unknown) => {
    if (!is_plain_object(raw_call) || !is_plain_object(raw_call.function)) {
      throw new Error("E_XAI_TOOL_CALL_INVALID");
    }

    const provider_function = raw_call.function as Dict;
    const id = ensure_optional_string(raw_call.id);
    const name = ensure_optional_string(provider_function.name);
    if (!id || !name) {
      throw new Error("E_XAI_TOOL_CALL_INVALID");
    }

    const raw_arguments = provider_function.arguments;
    let args: unknown;
    try {
      args = typeof raw_arguments === "string"
        ? JSON.parse(raw_arguments)
        : raw_arguments;
    } catch {
      throw new Error("E_XAI_TOOL_ARGUMENTS_INVALID");
    }

    if (!is_plain_object(args)) {
      throw new Error("E_XAI_TOOL_ARGUMENTS_INVALID");
    }

    return {
      _id: id,
      _name: name,
      _arguments: args
    };
  });
}

function finish_reason_from_response(
  raw: any,
  has_tool_calls: boolean
): XAIFinishReason {
  if (has_tool_calls) {
    return "tool_calls";
  }

  const choices = is_plain_object(raw) && Array.isArray(raw.choices)
    ? raw.choices
    : [];
  const first = is_plain_object(choices[0]) ? choices[0] : {};

  switch (first.finish_reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "other";
  }
}

function openai_tools(
  tools: XAIToolDefinition[]
) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool._name,
      ...(tool._description ? { description: tool._description } : {}),
      parameters: tool._input_schema
    }
  }));
}

function openai_tool_choice(
  choice: XAIToolChoice | undefined
): unknown {
  if (!choice || typeof choice === "string") {
    return choice;
  }

  return {
    type: "function",
    function: {
      name: choice._name
    }
  };
}

function openai_messages_from_input(
  input: XAIInput
): OpenAIChatMessage[] {
  const normalized =
    normalizeXAIInput(input);

  const messages: OpenAIChatMessage[] = [];

  const system =
    ensure_optional_string(
      input.system
    );

  if (system) {
    messages.push({
      role: "system",
      content: system
    });
  }

  for (const message of normalized.messages) {
    if (message._role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: message._tool_call_id,
        content: text_from_message(message)
      });
      continue;
    }

    if (message._role === "assistant") {
      const content = openai_content_from_message(message);
      messages.push({
        role: "assistant",
        content: content || null,
        ...(message._tool_calls?.length
          ? {
            tool_calls: message._tool_calls.map((call) => ({
              id: call._id,
              type: "function" as const,
              function: {
                name: call._name,
                arguments: JSON.stringify(call._arguments)
              }
            }))
          }
          : {})
      });
      continue;
    }

    messages.push({
      role: message._role,
      content: openai_content_from_message(message)
    });
  }

  return messages;
}

function text_from_message(
  message: XAIMessage
): string {
  return message._content
    .map((part) => part._type === "text" ? part._text : "")
    .filter(Boolean)
    .join("\n");
}

function openai_content_from_message(
  message: XAIMessage
): string | OpenAIChatContentPart[] {
  const has_image =
    message._content.some((part) =>
      part._type === "image"
    );

  if (!has_image) {
    return message._content
      .map((part) => part._type === "text" ? part._text : "")
      .filter(Boolean)
      .join("\n");
  }

  return message._content.map(openai_content_part);
}

function openai_content_part(
  part: XAIContentPart
): OpenAIChatContentPart {
  if (part._type === "text") {
    return {
      type: "text",
      text: part._text
    };
  }

  return {
    type: "image_url",
    image_url: {
      url:
        `data:${part._mime_type};base64,` +
        part._data_base64
    }
  };
}

export class OpenAIProvider
  implements XAIProvider {

  _provider_id = "openai";
  private _endpoint: string;
  private _api_key: string;
  private _model: string;
  private _temperature?: number;

  constructor(
    config: OpenAIProviderConfig
  ) {

    this._endpoint =
      normalize_endpoint(
        config.endpoint ??
        OPENAI_ENDPOINT
      );

    this._api_key =
      ensure_optional_string(
        config.apiKey
      ) ?? "";

    this._model =
      ensure_optional_string(
        config.model
      ) ?? "";

    this._temperature =
      typeof config.temperature === "number" &&
        Number.isFinite(
          config.temperature
        )
        ? config.temperature
        : undefined;
    if (config._bounded_text) {
      if (Object.getPrototypeOf(this) !== OpenAIProvider.prototype || this.generate !== boundedGenerate) throw new Error("E_XAI_BOUND_PROVIDER_OVERRIDDEN");
      registerBoundedText(this, "openai", this._endpoint, config._bounded_text._transport);
    }
  }

  async generate(
    input: XAIInput
  ): Promise<XAIResult> {

    const bounded = boundedTextEnabled(this) ? prepareBoundedText(this, input) : undefined;
    if (bounded && !this._api_key) return boundedMissingCredential(this, input);
    if (!this._endpoint) {
      throw new Error(
        "Missing OpenAI endpoint"
      );
    }

    if (!this._api_key) {
      throw new Error(
        "Missing OpenAI API key"
      );
    }

    const model = bounded?._wire_model ?? input.model ?? this._model;
    if (!model) {
      throw new Error(
        "Missing OpenAI model"
      );
    }

    const normalized =
      normalizeXAIInput(input);

    const messages =
      openai_messages_from_input(
        input
      );
    const tools =
      openai_tools(normalized.tools);
    const tool_choice =
      openai_tool_choice(normalized.tool_choice);

    const url =
      `${this._endpoint}` +
      `/chat/completions`;

    let response: Response;

    try {

      response =
        await (bounded ? (url: string, init: RequestInit) => boundedTextFetch(this, url, init) : fetch)(url, {

          method: "POST",

          headers: {

            "Content-Type":
              "application/json",

            "Authorization":
              `Bearer ${this._api_key}`
          },

          body: JSON.stringify({

            model:model,

            messages,

            ...(!bounded && (input.temperature ?? this._temperature) !== undefined
              ? {
                temperature:
                  input.temperature ?? this._temperature
              }
              : {}),

            ...(input.response_format
              ? {
                response_format:
                  input.response_format
              }
              : {}),

            ...(bounded ? { max_completion_tokens: input.max_tokens, n: 1, stream: false, service_tier: "default", modalities: ["text"] } : {}),

            ...(!bounded && typeof input.max_tokens === "number"
              ? {
                max_tokens:
                  input.max_tokens
              }
              : {}),

            ...(tools.length > 0
              ? {
                tools,
                ...(tool_choice !== undefined
                  ? { tool_choice }
                  : {})
              }
              : {})
          })
        });

    } catch (err) {

      throw new Error(
        `OpenAI chat request failed: ` +
        sanitize_connection_error(err)
      );
    }

    let body: any;

    try {

      body =
        await response.json();

    } catch {

      throw new Error(
        "OpenAI chat returned non-JSON response"
      );
    }

    if (!response.ok) {
      if (bounded) throw boundedHTTPFailure(response.status);

      const detail =

        (
          is_plain_object(body) &&
          is_plain_object(body.error) &&
          ensure_optional_string(
            body.error.message
          )
        ) ??

        (
          is_plain_object(body) &&
          ensure_optional_string(
            body.message
          )
        ) ??

        `http_${response.status}`;

      throw new Error(
        `OpenAI chat failed (${detail})`
      );
    }

    const text =
      extract_chat_text(body) ?? "";
    const tool_calls =
      extract_tool_calls(body);

    if (!bounded && !text && tool_calls.length === 0) {

      throw new Error(
        "OpenAI chat response missing assistant text"
      );
    }

    const usage =
      extract_usage(body);

    return {
      text,
      ...(tool_calls.length > 0 ? { tool_calls } : {}),
      finish_reason: finish_reason_from_response(body, tool_calls.length > 0),
      raw: body,
      usage
    };
  }
}

export default OpenAIProvider;

const boundedGenerate = OpenAIProvider.prototype.generate;
