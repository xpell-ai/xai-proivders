import type {
  XAIInput,
  XAIProvider,
  XAIResult,

} from "@xpell/node";

import { _xlog, _xu } from "@xpell/node";
type Dict =
  Record<string, unknown>;

export type AimeProviderConfig = {
  endpoint: string;
  apiKey: string;
  timeoutMs?: number;
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

function extract_result_payload(
  raw: any
): Dict | undefined {
  if (!is_plain_object(raw)) {
    return undefined;
  }

  const payload =
    is_plain_object(raw._payload)
      ? raw._payload
      : raw;

  const result =
    is_plain_object(payload._result)
      ? payload._result
      : undefined;

  return result;
}

function make_wormhole_request_id() {
  return `aime-provider-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
}



export class AimeProvider implements XAIProvider {

  _provider_id = "aime";
  private _endpoint: string;
  private _api_key: string;
  private _timeout_ms: number;

  constructor(
    config: AimeProviderConfig
  ) {
    this._endpoint =
      normalize_endpoint(
        config.endpoint
      );

    this._api_key =
      ensure_optional_string(
        config.apiKey
      ) ?? "";

    this._timeout_ms =
      typeof config.timeoutMs === "number" &&
        Number.isFinite(config.timeoutMs)
        ? config.timeoutMs
        : 60_000;
  }


  private async callRouter(
    op: string,
    params: Record<string, any>
  ): Promise<any> {
    if (!this._endpoint) {
      throw new Error("Missing Aime endpoint");
    }

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        this._timeout_ms
      );

    try {
      const response =
        await fetch(
          `${this._endpoint}/wh/v2/call`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            signal: controller.signal,
            body: JSON.stringify({
              _v: 2,
              _id: make_wormhole_request_id(),
              _kind: "REQ",
              _ts: Date.now(),
              _payload: {
                _module: "xai-router",
                _op: op,
                _params: params
              }
            })
          }
        );

      const body =
        await response.json();

      if (!response.ok) {
        throw new Error(
          `Aime provider failed: http_${response.status}`
        );
      }

      const result =
        extract_result_payload(body);

      if (!result) {
        throw new Error(
          "Aime provider response missing result payload"
        );
      }

      return result;

    } finally {
      clearTimeout(timeout);
    }
  }

  async generate(
    input: XAIInput
  ): Promise<XAIResult> {
    if (!this._api_key) {
      throw new Error(
        "Missing Aime API key"
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

    const result: any =
      await this.callRouter(
        "generate",
        {
          _api_key: this._api_key,
          _prompt: prompt,

          ...(input._task
            ? { _task: input._task }
            : {}),

          ...(input._capability
            ? { _capability: input._capability }
            : {}),

          ...(input.system
            ? { _system: input.system }
            : {}),

          ...(input.context
            ? { _context: input.context }
            : {}),

          ...(input.response_format
            ? { _response_format: input.response_format }
            : {})
        }
      );

    if (result._ok !== true) {
      const code =
        is_plain_object(result._error)
          ? ensure_optional_string(result._error._code)
          : undefined;

      const message =
        is_plain_object(result._error)
          ? ensure_optional_string(result._error._message)
          : undefined;

      throw new Error(
        `Aime provider generate failed` +
        (code ? ` (${code})` : "") +
        (message ? `: ${message}` : "")
      );
    }

    const text =
      ensure_optional_string(
        result._text
      );

    if (!text) {
      throw new Error(
        "Aime provider response missing generated text"
      );
    }

    const usage =
      is_plain_object(result._usage)
        ? {
          input_tokens: Number(result._usage._input_tokens ?? 0),
          output_tokens: Number(result._usage._output_tokens ?? 0),
          total_tokens: Number(result._usage._total_tokens ?? 0)
        }
        : undefined;

    return {
      text,
      raw: result,
      usage
    };
  }

  async testKey() {
    if (!this._api_key) {
      return {
        valid: false,
        message: "Missing API key"
      };
    }

    try {
      const result =
        await this.callRouter(
          "test-key",
          {
            _api_key:
              this._api_key
          }
        );

      if (result._ok !== true) {
        return {
          valid: false,
          message:
            ensure_optional_string(
              result?._error?._message
            )
        };
      }

      return {
        valid: true,
        account:
          ensure_optional_string(
            result._account
          ),
        account_id:
          ensure_optional_string(
            result._account_id
          ),
        raw: result
      };

    } catch (err) {
      return {
        valid: false,
        message:
          err instanceof Error
            ? err.message
            : String(err)
      };
    }
  }

  setApiKey(apiKey: string): void {
    this._api_key =
      ensure_optional_string(apiKey) ?? "";
  }

  configure(config: Record<string, any>): void {
    if (typeof config.apiKey === "string") {
      this.setApiKey(config.apiKey);
    }

    if (typeof config.endpoint === "string") {
      this._endpoint =
        normalize_endpoint(config.endpoint);
    }

    if (
      typeof config.timeoutMs === "number" &&
      Number.isFinite(config.timeoutMs)
    ) {
      this._timeout_ms = config.timeoutMs;
    }
  }

  async getMetadata() {
    return {
      provider: this._provider_id,
      connected: Boolean(this._api_key && this._endpoint),
      endpoint: this._endpoint
    };
  }
}

export default AimeProvider;