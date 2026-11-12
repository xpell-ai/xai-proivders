import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type {
  XAIDocumentExtractionInput,
  XAIDocumentExtractionResult,
  XAIGenerationRecoveryInput,
  XAIGenerationRecoveryResult,
  XAIInput,
  XAIProvider,
  XAIResult,

} from "@xpell/node";

import {
  _xlog,
  _xu,
  normalizeXAIFinishReason,
  normalizeXAIInput,
  normalizeXAIToolCalls
} from "@xpell/node";
type Dict =
  Record<string, unknown>;

export type AimeProviderConfig = {
  endpoint: string;
  apiKey: string;
  timeoutMs?: number;
  resolveFileRef?: AimeFileRefResolver;
};

export type AimeResolvedDocumentFile = {
  _filename: string;
  _mime_type: string;
  _size_bytes: number;
  _sha256?: string;
  _bytes?: Buffer | Uint8Array | ArrayBuffer;
  openReadStream?: () => Readable | NodeJS.ReadableStream;
};

export type AimeFileRefResolveRequirements = {
  _app_id: string;
  _env: string;
  _accepted_mime_types: readonly string[];
  _max_size_bytes: number;
};

export type AimeFileRefResolver = (
  file_ref: Record<string, unknown>,
  requirements: AimeFileRefResolveRequirements
) => Promise<AimeResolvedDocumentFile>;

export type XAIRouterFileRef = {
  _type: "xai-file-ref";
  _id: string;
  _mime_type: string;
  _filename: string;
  _size_bytes: number;
  _sha256: string;
  _created_at?: string;
  _expires_at?: string;
};

const is_plain_object =
  (_xu as any).is_plain_object as (value: unknown) => value is Dict;
const XAI_ROUTER_FILE_REF_TYPE = "xai-file-ref";
const XPELL_FILE_REF_TYPE = "xpell-file-ref";
const XAI_DOCUMENT_UPLOAD_PATH = "/xai-router/v1/files";
const DEFAULT_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
const DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp"
] as const;

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

function sanitize_response_preview(
  value: string
): string {
  return value
    .slice(0, 200)
    .replace(
      /Bearer\s+[A-Za-z0-9._-]+/gi,
      "Bearer [redacted]"
    )
    .replace(
      /(key|token|secret|password)=([^&\s]+)/gi,
      "$1=[redacted]"
    )
    .replace(
      /[A-Za-z0-9_-]{40,}/g,
      "[redacted]"
    );
}

function safe_endpoint(
  value: string
): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|password/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return sanitize_response_preview(value);
  }
}

function is_json_content_type(
  content_type: string
): boolean {
  const normalized =
    content_type.toLowerCase();

  return normalized.includes("application/json") ||
    normalized.includes("+json");
}

function transport_diagnostic_error(args: {
  operation: string;
  endpoint: string;
  status: number;
  content_type: string;
  preview: string;
  provider?: string;
  model?: string;
}): Error {
  const message =
    `Aime provider ${args.operation} returned non-JSON response` +
    ` (status=${args.status}, content_type=${args.content_type || "unknown"}, endpoint=${safe_endpoint(args.endpoint)}` +
    (args.provider ? `, provider=${args.provider}` : "") +
    (args.model ? `, model=${args.model}` : "") +
    (args.preview ? `, preview=${args.preview}` : "") +
    ")";

  const error = new Error(message) as Error & {
    _code?: string;
    _details?: Dict;
  };

  error._code = "E_XAI_TRANSPORT_NON_JSON";
  error._details = {
    status: args.status,
    content_type: args.content_type || "unknown",
    endpoint: safe_endpoint(args.endpoint),
    ...(args.provider ? { provider: args.provider } : {}),
    ...(args.model ? { model: args.model } : {}),
    preview: args.preview
  };

  return error;
}

async function parse_json_response(
  response: Response,
  args: {
    operation: string;
    endpoint: string;
    provider?: string;
    model?: string;
  }
): Promise<any> {
  const content_type =
    response.headers.get("content-type") ?? "";
  const text =
    await response.text();

  if (!is_json_content_type(content_type)) {
    throw transport_diagnostic_error({
      ...args,
      status: response.status,
      content_type,
      preview: sanitize_response_preview(text)
    });
  }

  try {
    return JSON.parse(text);
  } catch {
    throw transport_diagnostic_error({
      ...args,
      status: response.status,
      content_type,
      preview: sanitize_response_preview(text)
    });
  }
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

  if (
    typeof payload._ok === "boolean" &&
    is_plain_object(payload._result)
  ) {
    return payload;
  }

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

function safe_runtime_metadata(
  value: unknown
): Dict {
  if (!is_plain_object(value)) {
    return {};
  }

  const metadata: Dict = {};

  for (const key of [
    "_app_id",
    "_env",
    "_caller_module",
    "_caller_op",
    "_purpose",
    "_request_id",
    "_idempotency_key"
  ]) {
    const entry =
      ensure_optional_string(value[key]);

    if (entry) {
      metadata[key] = entry;
    }
  }

  return metadata;
}

function make_router_failure_error(
  operation: string,
  result: any
): Error {
  const code =
    is_plain_object(result?._error)
      ? ensure_optional_string(result._error._code)
      : undefined;

  const message =
    is_plain_object(result?._error)
      ? ensure_optional_string(result._error._message)
      : undefined;

  const details =
    is_plain_object(result?._error) &&
      is_plain_object(result._error._details)
      ? result._error._details
      : undefined;

  const provider_message =
    ensure_optional_string(details?._error_message) ??
    ensure_optional_string(details?._message);

  const error = new Error(
    `Aime provider ${operation} failed` +
    (code ? ` (${code})` : "") +
    (message ? `: ${message}` : "") +
    (provider_message ? `; ${provider_message}` : "")
  ) as Error & {
    _code?: string;
    _details?: Dict;
  };

  if (code) {
    error._code = code;
  }

  if (details) {
    error._details = details;
  }

  return error;
}

function structured_json_text(
  generated: Dict
): string | undefined {
  if (is_plain_object(generated._object)) {
    return JSON.stringify(generated._object);
  }

  if (
    generated._ok === true &&
    is_plain_object(generated._result)
  ) {
    return JSON.stringify(generated._result);
  }

  const envelope_keys =
    new Set([
      "_ok",
      "_error",
      "_usage",
      "_provider",
      "_model",
      "_task"
    ]);

  if (
    !Object.keys(generated)
      .some((key) => envelope_keys.has(key))
  ) {
    return JSON.stringify(generated);
  }

  return undefined;
}

function assert_no_local_path_fields(
  value: unknown,
  path = "$"
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assert_no_local_path_fields(item, `${path}[${index}]`)
    );
    return;
  }

  if (!is_plain_object(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (
      normalized === "path" ||
      normalized === "_path" ||
      normalized === "filepath" ||
      normalized === "_filepath" ||
      normalized === "absolute_path" ||
      normalized === "_absolute_path" ||
      normalized === "browser_path" ||
      normalized === "_browser_path"
    ) {
      throw new Error(
        `Aime provider document input cannot include local path field ${path}.${key}`
      );
    }

    assert_no_local_path_fields(child, `${path}.${key}`);
  }
}

function is_router_file_ref(
  value: unknown
): value is XAIRouterFileRef {
  return is_plain_object(value) &&
    value._type === XAI_ROUTER_FILE_REF_TYPE &&
    typeof value._id === "string" &&
    value._id.trim().length > 0;
}

function is_xpell_file_ref(
  value: unknown
): value is Record<string, unknown> {
  return is_plain_object(value) &&
    value._type === XPELL_FILE_REF_TYPE &&
    value._version === 1;
}

function read_file_ref_from_input(
  input: XAIDocumentExtractionInput
): unknown {
  const raw = input as any;
  if (raw.file_ref !== undefined) {
    return raw.file_ref;
  }

  if (is_plain_object(raw.document) && raw.document.file_ref !== undefined) {
    return raw.document.file_ref;
  }

  return undefined;
}

function document_params_for_router(
  input: XAIDocumentExtractionInput,
  file_ref: XAIRouterFileRef
): Record<string, unknown> {
  return {
    _api_key: undefined,
    document: {
      file_ref
    },
    ...(input.options ? { options: input.options } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

function required_ref_string(
  record: Record<string, unknown>,
  field: string
): string {
  const value = ensure_optional_string(record[field]);
  if (!value) {
    throw new Error(`Aime provider file ref ${field} is required`);
  }
  return value;
}

function sanitize_upload_filename(value: unknown): string {
  const raw =
    typeof value === "string" && value.trim()
      ? value.trim()
      : "document";
  const base = raw.replaceAll("\\", "/").split("/").pop() ?? "document";
  const safe = base
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .slice(0, 160)
    .trim();

  return safe || "document";
}

function extension_matches_mime(
  filename: string,
  mime_type: string
): boolean {
  const lower = filename.toLowerCase();
  if (mime_type === "application/pdf") return lower.endsWith(".pdf");
  if (mime_type === "image/png") return lower.endsWith(".png");
  if (mime_type === "image/jpeg") return lower.endsWith(".jpg") || lower.endsWith(".jpeg");
  if (mime_type === "image/webp") return lower.endsWith(".webp");
  return false;
}

function assert_document_mime(
  value: unknown
): string {
  const mime_type = ensure_optional_string(value)?.toLowerCase();
  if (!mime_type || !(DOCUMENT_MIME_TYPES as readonly string[]).includes(mime_type)) {
    throw new Error("Aime provider document MIME type is unsupported");
  }
  return mime_type;
}

function buffer_from_bytes(
  value: Buffer | Uint8Array | ArrayBuffer
): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }

  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

async function read_stream_to_buffer(
  stream: Readable | NodeJS.ReadableStream,
  max_bytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk);
    total += bytes.length;
    if (total > max_bytes) {
      throw new Error("Aime provider resolved document exceeds maximum upload size");
    }
    chunks.push(bytes);
  }

  return Buffer.concat(chunks as unknown as Uint8Array[]);
}

function to_uint8array_copy(
  bytes: Buffer
): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

async function bytes_from_resolved_file(
  resolved: AimeResolvedDocumentFile,
  max_bytes: number
): Promise<Buffer> {
  if (resolved._bytes !== undefined) {
    const bytes = buffer_from_bytes(resolved._bytes);
    if (bytes.length > max_bytes) {
      throw new Error("Aime provider resolved document exceeds maximum upload size");
    }
    return bytes;
  }

  if (typeof resolved.openReadStream === "function") {
    return read_stream_to_buffer(resolved.openReadStream(), max_bytes);
  }

  throw new Error(
    "Aime provider file resolver must return bytes or openReadStream"
  );
}



export class AimeProvider implements XAIProvider {

  _provider_id = "aime";
  private _endpoint: string;
  private _api_key: string;
  private _timeout_ms: number;
  private _resolve_file_ref?: AimeFileRefResolver;

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

    this._resolve_file_ref =
      config.resolveFileRef;
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
      const endpoint =
        `${this._endpoint}/wh/v2/call`;

      const response =
        await fetch(
          endpoint,
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
        await parse_json_response(
          response,
          {
            operation: op,
            endpoint,
            provider: "xai-router",
            model: ensure_optional_string(params._model)
          }
        );

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

  private async uploadDocumentFile(
    resolved: AimeResolvedDocumentFile
  ): Promise<XAIRouterFileRef> {
    if (!this._endpoint) {
      throw new Error("Missing Aime endpoint");
    }

    if (!this._api_key) {
      throw new Error("Missing Aime API key");
    }

    const mime_type =
      assert_document_mime(resolved._mime_type);

    const filename =
      sanitize_upload_filename(resolved._filename);

    if (!extension_matches_mime(filename, mime_type)) {
      throw new Error(
        "Aime provider document filename extension does not match MIME type"
      );
    }

    const bytes =
      await bytes_from_resolved_file(
        resolved,
        DEFAULT_DOCUMENT_MAX_BYTES
      );

    const sha256 =
      createHash("sha256")
        .update(to_uint8array_copy(bytes))
        .digest("hex");

    if (
      resolved._sha256 &&
      resolved._sha256.toLowerCase() !== sha256
    ) {
      throw new Error(
        "Aime provider resolved document SHA-256 mismatch"
      );
    }

    const form =
      new FormData();

    form.append(
      "file",
      new Blob([to_uint8array_copy(bytes)], { type: mime_type }),
      filename
    );

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        this._timeout_ms
      );

    try {
      const endpoint =
        `${this._endpoint}${XAI_DOCUMENT_UPLOAD_PATH}`;

      const response =
        await fetch(
          endpoint,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${this._api_key}`,
              "x-xai-document-sha256": sha256,
              "x-xai-document-size": String(bytes.length)
            },
            signal: controller.signal,
            body: form
          }
        );

      const body =
        await parse_json_response(
          response,
          {
            operation: "document upload",
            endpoint,
            provider: "xai-router"
          }
        );

      if (!response.ok) {
        const code =
          ensure_optional_string(body?._result?._code) ??
          ensure_optional_string(body?._error?._code);
        throw new Error(
          `Aime provider document upload failed: http_${response.status}` +
          (code ? ` (${code})` : "")
        );
      }

      const file_ref =
        body?._result?.file_ref;

      if (!is_router_file_ref(file_ref)) {
        throw new Error(
          "Aime provider document upload response missing xai-file-ref"
        );
      }

      return file_ref;
    } catch (err) {
      if (err instanceof Error) {
        throw new Error(
          sanitize_connection_error(err)
        );
      }

      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async resolveAndUploadLocalFileRef(
    file_ref: Record<string, unknown>
  ): Promise<XAIRouterFileRef> {
    if (!this._resolve_file_ref) {
      throw new Error(
        "Aime provider document extraction requires a trusted file_ref resolver"
      );
    }

    const app_id =
      required_ref_string(file_ref, "_app_id");
    const env =
      required_ref_string(file_ref, "_env");
    const mime_type =
      assert_document_mime(file_ref._mime_type);
    const filename =
      sanitize_upload_filename(file_ref._filename);
    const size_bytes =
      Number(file_ref._size_bytes);

    if (!Number.isSafeInteger(size_bytes) || size_bytes < 0) {
      throw new Error("Aime provider file ref size is invalid");
    }

    if (size_bytes > DEFAULT_DOCUMENT_MAX_BYTES) {
      throw new Error("Aime provider file ref exceeds maximum upload size");
    }

    if (!extension_matches_mime(filename, mime_type)) {
      throw new Error(
        "Aime provider file ref extension does not match MIME type"
      );
    }

    const resolved =
      await this._resolve_file_ref(
        file_ref,
        {
          _app_id: app_id,
          _env: env,
          _accepted_mime_types: DOCUMENT_MIME_TYPES,
          _max_size_bytes: DEFAULT_DOCUMENT_MAX_BYTES
        }
      );

    return this.uploadDocumentFile({
      ...resolved,
      _filename: resolved._filename || filename,
      _mime_type: resolved._mime_type || mime_type,
      _size_bytes: resolved._size_bytes || size_bytes,
      _sha256: resolved._sha256 ?? ensure_optional_string(file_ref._sha256)
    });
  }

  async extractDocument(
    input: XAIDocumentExtractionInput
  ): Promise<XAIDocumentExtractionResult> {
    if (!this._api_key) {
      throw new Error(
        "Missing Aime API key"
      );
    }

    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Aime provider document input is invalid");
    }

    assert_no_local_path_fields(input);

    const document_ref =
      read_file_ref_from_input(input);

    let router_file_ref: XAIRouterFileRef | undefined;

    if (is_router_file_ref(document_ref)) {
      router_file_ref = document_ref;
    } else if (is_xpell_file_ref(document_ref)) {
      router_file_ref =
        await this.resolveAndUploadLocalFileRef(document_ref);
    } else if (document_ref !== undefined) {
      throw new Error(
        "Aime provider document file_ref type is unsupported"
      );
    }

    const params =
      router_file_ref
        ? {
          ...document_params_for_router(input, router_file_ref),
          _api_key: this._api_key
        }
        : {
          _api_key: this._api_key,
          ...(input.document ? { document: input.document } : {}),
          ...(input.options ? { options: input.options } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        };

    const result: any =
      await this.callRouter(
        "extract_document",
        params
      );

    if (result._ok !== true) {
      throw make_router_failure_error(
        "extractDocument",
        result
      );
    }

    const document_result =
      result._result;

    if (!is_plain_object(document_result)) {
      throw new Error(
        "Aime provider extractDocument response missing result"
      );
    }

    return document_result as XAIDocumentExtractionResult;
  }

  async generate(
    input: XAIInput
  ): Promise<XAIResult> {
    if (!this._api_key) {
      throw new Error(
        "Missing Aime API key"
      );
    }

    if (
      input.messages !== undefined &&
      !Array.isArray(input.messages)
    ) {
      throw new Error(
        "E_XAI_MESSAGES_INVALID"
      );
    }

    const normalized_input =
      normalizeXAIInput(input);

    const has_messages =
      Array.isArray(input.messages);

    const result: any =
      await this.callRouter(
        "generate",
        {
          _api_key: this._api_key,
          _prompt: normalized_input.prompt,

          ...(has_messages
            ? { _messages: normalized_input.messages }
            : {}),

          ...(normalized_input.tools.length > 0
            ? { _tools: normalized_input.tools }
            : {}),

          ...(normalized_input.tool_choice
            ? { _tool_choice: normalized_input.tool_choice }
            : {}),

          ...(input._task
            ? { _task: input._task }
            : {}),

          ...(input._capability
            ? { _capability: input._capability }
            : {}),

          ...(input.model
            ? { _model: input.model }
            : {}),

          ...(input.reasoning
            ? { _reasoning: input.reasoning }
            : {}),

          ...(input.system
            ? { _system: input.system }
            : {}),

          ...(input.context
            ? { _context: input.context }
            : {}),
          ...(input.max_tokens !== undefined ? { _max_tokens: input.max_tokens } : {}),

          ...safe_runtime_metadata(input.metadata),

          ...(input.response_format
            ? { _response_format: input.response_format }
            : {})
        }
      );

    if (result._ok !== true) {
      throw make_router_failure_error(
        "generate",
        result
      );
    }

    const generated =
      is_plain_object(result._result)
        ? result._result
        : result;

    if (generated._ok === false) {
      throw make_router_failure_error(
        "generate",
        generated
      );
    }

    const tool_calls =
      normalizeXAIToolCalls(
        generated._tool_calls
      );
    const finish_reason =
      normalizeXAIFinishReason(
        generated._finish_reason,
        tool_calls.length > 0
          ? "tool_calls"
          : "stop"
      );
    const text =
      ensure_optional_string(
        generated._text
      ) ??
      (
        input.response_format?.type === "json_object"
          ? structured_json_text(generated)
          : undefined
      );

    if (!text && tool_calls.length === 0) {
      throw new Error(
        "Aime provider response missing generated text"
      );
    }

    const usage =
      is_plain_object(generated._usage)
        ? {
          input_tokens: Number(generated._usage._input_tokens ?? 0),
          output_tokens: Number(generated._usage._output_tokens ?? 0),
          total_tokens: Number(generated._usage._total_tokens ?? 0),
          ...(typeof generated._usage._reasoning_tokens === "number"
            ? { reasoning_tokens: generated._usage._reasoning_tokens }
            : {}),
          ...(typeof generated._usage._cached_input_tokens === "number"
            ? { cached_input_tokens: generated._usage._cached_input_tokens }
            : {}),
          ...(typeof generated._usage._usage_source === "string"
            ? { usage_source: generated._usage._usage_source }
            : {})
        }
        : undefined;

    return {
      text: text ?? "",
      ...(tool_calls.length > 0 ? { tool_calls } : {}),
      ...(finish_reason ? { finish_reason } : {}),
      raw: generated,
      usage
    };
  }

  async recoverGeneration(
    input: XAIGenerationRecoveryInput
  ): Promise<XAIGenerationRecoveryResult> {
    if (!this._api_key) {
      throw new Error(
        "Missing Aime API key"
      );
    }

    const idempotency_key =
      ensure_optional_string(
        input?._idempotency_key
      );

    if (!idempotency_key) {
      throw new Error(
        "Missing idempotency key"
      );
    }

    const result: any =
      await this.callRouter(
        "recover_generation",
        {
          _api_key: this._api_key,
          _idempotency_key: idempotency_key
        }
      );

    if (result._ok !== true) {
      throw make_router_failure_error(
        "recoverGeneration",
        result
      );
    }

    return result as XAIGenerationRecoveryResult;
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

    if (typeof config.resolveFileRef === "function") {
      this._resolve_file_ref = config.resolveFileRef;
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
