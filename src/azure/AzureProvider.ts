import type {
  XAIInput,
  XAIProvider,
  XAIResult
} from "@xpell/node";

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

type AzureChatMessage = {
  role:
  | "system"
  | "user"
  | "assistant";
  content: string;
};

function is_plain_object(
  value: unknown
): value is Dict {

  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

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
  raw: unknown
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
  raw: unknown
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

export class AzureProvider
  implements XAIProvider {

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

    const prompt =
      ensure_optional_string(
        input.prompt
      );

    if (!prompt) {
      throw new Error(
        "Missing prompt"
      );
    }

    const messages:
      AzureChatMessage[] = [];

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

    messages.push({
      role: "user",
      content: prompt
    });

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

            ...(this._temperature !== undefined
              ? {
                temperature:
                  this._temperature
              }
              : {}),

            ...(input.response_format
              ? {
                response_format:
                  input.response_format
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

    let body: unknown;

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
      extract_chat_text(body);

    if (!text) {

      throw new Error(
        "Azure OpenAI chat response missing assistant text"
      );
    }

    const usage =
      extract_usage(body);

    return {
      text,
      raw: body,
      usage
    };
  }
}

export default AzureProvider;