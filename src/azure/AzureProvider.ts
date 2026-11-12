import type {
  XAIFinishReason,
  XAIInput,
  XAIMessage,
  XAIProvider,
  XAIResult,
  XAIToolCall,
  XAIToolChoice,
  XAIToolDefinition
} from "@xpell/node";

import { _xu, normalizeXAIInput } from "@xpell/node";

const AZURE_OPENAI_API_VERSION =
  "2024-02-15-preview";

type Dict =
  Record<string, unknown>;

export type AzureProviderConfig = {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion?: string;
  temperature?: number;
};

type AzureChatMessage =
  | {
    role: "system" | "user";
    content: string;
  }
  | {
    role: "assistant";
    content: string | null;
    tool_calls?: AzureToolCall[];
  }
  | {
    role: "tool";
    tool_call_id: string;
    content: string;
  };

type AzureToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
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

function text_from_message(
  message: XAIMessage
): string {
  if (message._content.some((part) => part._type === "image")) {
    throw new Error("E_XAI_AZURE_IMAGE_UNSUPPORTED");
  }

  return message._content
    .map((part) => part._type === "text" ? part._text : "")
    .filter(Boolean)
    .join("\n");
}

function azure_messages_from_input(
  input: XAIInput
): AzureChatMessage[] {
  const normalized = normalizeXAIInput(input);
  const messages: AzureChatMessage[] = [];
  const system = ensure_optional_string(input.system);

  if (system) {
    messages.push({ role: "system", content: system });
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
      const content = text_from_message(message);
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
      content: text_from_message(message)
    });
  }

  return messages;
}

function azure_tools(
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

function azure_tool_choice(
  choice: XAIToolChoice | undefined
): unknown {
  if (!choice || typeof choice === "string") {
    return choice;
  }

  return {
    type: "function",
    function: { name: choice._name }
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

    let args: unknown;
    try {
      args = typeof provider_function.arguments === "string"
        ? JSON.parse(provider_function.arguments)
        : provider_function.arguments;
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
    case "stop": return "stop";
    case "length": return "length";
    case "content_filter": return "content_filter";
    default: return "other";
  }
}

export class AzureProvider
  implements XAIProvider {

  _provider_id = "azure";
  private _endpoint: string;
  private _api_key: string;
  private _deployment: string;
  private _api_version: string;
  private _temperature?: number;

  constructor(
    config: AzureProviderConfig
  ) {

    this._endpoint =
      normalize_endpoint(
        config.endpoint
      );

    this._api_key =
      ensure_optional_string(
        config.apiKey
      ) ?? "";

    this._deployment =
      ensure_optional_string(
        config.deployment
      ) ?? "";

    this._api_version =
      ensure_optional_string(
        config.apiVersion
      ) ??
      AZURE_OPENAI_API_VERSION;

    this._temperature =
      typeof config.temperature === "number" &&
        Number.isFinite(
          config.temperature
        )
        ? config.temperature
        : undefined;
  }

  async generate(
    input: XAIInput
  ): Promise<XAIResult> {

    if (!this._endpoint) {
      throw new Error(
        "Missing Azure OpenAI endpoint"
      );
    }

    if (!this._api_key) {
      throw new Error(
        "Missing Azure OpenAI API key"
      );
    }

    if (!this._deployment) {
      throw new Error(
        "Missing Azure OpenAI deployment"
      );
    }

    const normalized =
      normalizeXAIInput(input);
    const messages =
      azure_messages_from_input(input);
    const tools =
      azure_tools(normalized.tools);
    const tool_choice =
      azure_tool_choice(normalized.tool_choice);
    const temperature =
      input.temperature ?? this._temperature;

    const url =
      `${this._endpoint}` +
      `/openai/deployments/` +
      `${encodeURIComponent(this._deployment)}` +
      `/chat/completions` +
      `?api-version=${encodeURIComponent(this._api_version)}`;

    let response: Response;

    try {

      response =
        await fetch(url, {

          method: "POST",

          headers: {

            "content-type":
              "application/json",

            "api-key":
              this._api_key
          },

          body: JSON.stringify({

            messages,

            ...(temperature !== undefined
              ? {
                temperature:
                  temperature
              }
              : {}),

            ...(input.response_format
              ? {
                response_format:
                  input.response_format
              }
              : {}),

            ...(typeof input.max_tokens === "number"
              ? { max_tokens: input.max_tokens }
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
        `Azure OpenAI chat request failed: ` +
        sanitize_connection_error(err)
      );
    }

    let body: any;

    try {

      body =
        await response.json();

    } catch {

      throw new Error(
        "Azure OpenAI chat returned non-JSON response"
      );
    }

    if (!response.ok) {

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
        `Azure OpenAI chat failed (${detail})`
      );
    }

    const text =
      extract_chat_text(body) ?? "";
    const tool_calls =
      extract_tool_calls(body);

    if (!text && tool_calls.length === 0) {

      throw new Error(
        "Azure OpenAI chat response missing assistant text"
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

export default AzureProvider;
