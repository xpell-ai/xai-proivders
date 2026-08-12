import type {
  XAIInput,
  XAIProvider,
  XAIResult
} from "@xpell/node";

import { _xu } from "@xpell/node";

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta";

type Dict =
  Record<string, unknown>;

export type GeminiProviderConfig = {
  apiKey: string;
  model?: string;
  endpoint?: string;
  temperature?: number;
};

const is_plain_object = (_xu as any).is_plain_object;

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

function extract_gemini_text(
  raw: any
): string | undefined {

  if (!is_plain_object(raw)) {
    return undefined;
  }

  const candidates =
    Array.isArray(raw.candidates)
      ? raw.candidates
      : [];

  if (candidates.length === 0) {
    return undefined;
  }

  const first =
    is_plain_object(candidates[0])
      ? candidates[0]
      : {};

  const content =
    is_plain_object(first.content)
      ? first.content
      : {};

  const parts =
    Array.isArray(content.parts)
      ? content.parts
      : [];

  const text_parts: string[] = [];

  for (const part of parts) {

    if (!is_plain_object(part)) {
      continue;
    }

    if (
      typeof part.text === "string" &&
      part.text.trim().length > 0
    ) {

      text_parts.push(
        part.text.trim()
      );
    }
  }

  if (text_parts.length > 0) {

    return text_parts.join("\n");
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
    is_plain_object(raw.usageMetadata)
      ? raw.usageMetadata
      : undefined;

  if (!usage) {
    return undefined;
  }

  return {
    input_tokens:
      typeof usage.promptTokenCount === "number"
        ? usage.promptTokenCount
        : undefined,

    output_tokens:
      typeof usage.candidatesTokenCount === "number"
        ? usage.candidatesTokenCount
        : undefined,

    total_tokens:
      typeof usage.totalTokenCount === "number"
        ? usage.totalTokenCount
        : undefined
  };
}

function build_generation_config(
  temperature: number | undefined,
  response_format: XAIInput["response_format"]
): Dict | undefined {

  const generation_config: Dict = {};

  if (temperature !== undefined) {
    generation_config.temperature =
      temperature;
  }

  if (response_format?.type === "json_object") {
    generation_config.responseMimeType =
      "application/json";
  }

  return Object.keys(generation_config).length > 0
    ? generation_config
    : undefined;
}

export class GeminiProvider
  implements XAIProvider {

  _provider_id = "gemini";
  private _endpoint: string;
  private _api_key: string;
  private _model: string;
  private _temperature?: number;

  constructor(
    config: GeminiProviderConfig
  ) {

    this._endpoint =
      normalize_endpoint(
        config.endpoint ??
        GEMINI_ENDPOINT
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
  }

  async generate(
    input: XAIInput
  ): Promise<XAIResult> {

    if (!this._endpoint) {
      throw new Error(
        "Missing Gemini endpoint"
      );
    }

    if (!this._api_key) {
      throw new Error(
        "Missing Gemini API key"
      );
    }

    const model = input.model ?? this._model;
    if (!model) {
      throw new Error(
        "Missing Gemini model"
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

    const system =
      ensure_optional_string(
        input.system
      );

    const text =
      system
        ? `${system}\n\n${prompt}`
        : prompt;

    const generation_config =
      build_generation_config(
        this._temperature,
        input.response_format
      );

    const url =
      `${this._endpoint}` +
      `/models/` +
      `${encodeURIComponent(model)}` +
      `:generateContent` +
      `?key=${encodeURIComponent(this._api_key)}`;

    let response: Response;

    try {

      response =
        await fetch(url, {

          method: "POST",

          headers: {

            "content-type":
              "application/json"
          },

          body: JSON.stringify({

            contents: [
              {
                parts: [
                  {
                    text
                  }
                ]
              }
            ],

            ...(generation_config
              ? {
                generationConfig:
                  generation_config
              }
              : {})
          })
        });

    } catch (err) {

      throw new Error(
        `Gemini generateContent request failed: ` +
        sanitize_connection_error(err)
      );
    }

    let body: any;

    try {

      body =
        await response.json();

    } catch {

      throw new Error(
        "Gemini generateContent returned non-JSON response"
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
        `Gemini generateContent failed (${detail})`
      );
    }

    const generated_text =
      extract_gemini_text(body);

    if (!generated_text) {

      throw new Error(
        "Gemini generateContent response missing generated text"
      );
    }

    const usage =
      extract_usage(body);

    return {
      text: generated_text,
      raw: body,
      usage
    };
  }
}

export default GeminiProvider;
