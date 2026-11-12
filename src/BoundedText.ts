import { GEMINI_35_FLASH_LITE, boundedGeminiConversation, validateBoundedGeminiConversation } from "./BoundedGeminiConversation.js";
import type { XAIInput, XAIProvider, XAIResult } from "@xpell/node";

export type DocumentedTextModel = Readonly<{ _provider: "openai" | "gemini"; _model: string; _wire_model: string;
  _input_tokens: number; _model_output_tokens: number; _input_usd_per_1m: number; _output_usd_per_1m: number;
  _endpoint: string; _expires_at: string; _contract: "documented-text-context-v1";
  _long_prompt?: Readonly<{ _above: number; _input: number; _output: number; _cached_input: number }> }>;
const catalog = [
  ["openai", "gpt-4o-mini", "gpt-4o-mini-2024-07-18", 128000, 16384, 0.15, 0.6],
  ["openai", "gpt-5-mini", "gpt-5-mini-2025-08-07", 400000, 128000, 0.25, 2],
  ["gemini", "gemini-2.5-flash-lite", "gemini-2.5-flash-lite", 1048576, 65536, 0.1, 0.4],
  ["gemini", "gemini-2.5-flash", "gemini-2.5-flash", 1048576, 65536, 0.3, 2.5],
  ["gemini", GEMINI_35_FLASH_LITE, GEMINI_35_FLASH_LITE, 1048576, 65536, 0.3, 2.5],
  ["gemini", "gemini-2.5-pro", "gemini-2.5-pro", 1048576, 65536, 1.25, 10],
] as const;
/** Versioned source contract, verified 2026-11-04. Expiry is an application
 * re-verification deadline, also preceding Flash's documented alias replacement.
 * Input is the entire documented context ceiling, never a tokenizer estimate. */
export function documentedTextModel(provider: string, model: string): DocumentedTextModel {
  const row = catalog.find(r => r[0] === provider && (r[1] === model || r[2] === model));
  if (!row) throw boundedFailure("bound_unsupported");
  return Object.freeze({ _provider: row[0], _model: row[1], _wire_model: row[2], _input_tokens: row[3], _model_output_tokens: row[4],
    _input_usd_per_1m: row[5], _output_usd_per_1m: row[6], _endpoint: row[0] === "openai" ? "https://api.openai.com/v1" : "https://generativelanguage.googleapis.com/v1beta",
    _expires_at: row[2] === GEMINI_35_FLASH_LITE ? "2027-01-01T00:00:00.000Z" : "2026-12-01T00:00:00.000Z", _contract: "documented-text-context-v1",
    ...(row[2] === "gemini-2.5-pro" ? { _long_prompt: Object.freeze({ _above: 200000, _input: 2.5, _output: 15, _cached_input: 0.25 }) } : {}) });
}
type Registration = { kind: "openai" | "gemini"; endpoint: string; generate: XAIProvider["generate"]; transport?: typeof fetch };
const providers = new WeakMap<object, Registration>();
const receipts = new WeakMap<object, { provider: object; input: XAIInput }>();
export function boundedFailure(classification: string): Error & { _classification: string; _code: string } {
  return Object.assign(new Error(classification), { _classification: classification, _code: `E_XAI_BOUND_${classification.toUpperCase()}` });
}
// Internal registration, intentionally not re-exported by the package entrypoint.
export function registerBoundedText(provider: XAIProvider, kind: Registration["kind"], endpoint: string, transport?: typeof fetch) {
  const expected = kind === "openai" ? "https://api.openai.com/v1" : "https://generativelanguage.googleapis.com/v1beta";
  if (endpoint !== expected) throw boundedFailure("endpoint_unsupported");
  providers.set(provider, { kind, endpoint, generate: provider.generate, transport });
}
export function boundedTextEnabled(provider: object): boolean { return providers.has(provider); }
export function prepareBoundedText(provider: XAIProvider, input: XAIInput): DocumentedTextModel {
  const registration = providers.get(provider);
  if (!registration || registration.generate !== provider.generate) throw boundedFailure("bound_unsupported");
  const descriptor = documentedTextModel(registration.kind, input.model ?? "");
  if (Date.now() >= Date.parse(descriptor._expires_at)) throw boundedFailure("contract_expired");
  if (boundedGeminiConversation(input)) {
    if (!["gemini-2.5-flash", "gemini-2.5-pro", GEMINI_35_FLASH_LITE].includes(descriptor._wire_model)) throw boundedFailure("request_unsupported");
    validateBoundedGeminiConversation(input);
    return descriptor;
  }
  if (descriptor._wire_model === "gemini-2.5-pro" || descriptor._wire_model === GEMINI_35_FLASH_LITE) throw boundedFailure("request_unsupported");
  if (Object.keys(input).some(k => !["model", "prompt", "system", "max_tokens", "response_format", "metadata"].includes(k)) ||
      typeof input.prompt !== "string" || !input.prompt.trim() || (input.system !== undefined && typeof input.system !== "string") ||
      !Number.isSafeInteger(input.max_tokens) || input.max_tokens! < 1 || input.max_tokens! > Math.min(4096, descriptor._model_output_tokens) ||
      (input.response_format !== undefined && (Object.keys(input.response_format).some(k => k !== "type") || !["text", "json_object"].includes(input.response_format.type))) ||
      Buffer.byteLength(JSON.stringify(input)) > 16384) throw boundedFailure("request_unsupported");
  return descriptor;
}
export function boundedTextFetch(provider: XAIProvider, url: string, init: RequestInit): Promise<Response> {
  const registration = providers.get(provider);
  if (!registration || registration.generate !== provider.generate || !url.startsWith(registration.endpoint + "/")) throw boundedFailure("endpoint_unsupported");
  const target = new URL(url);
  if (registration.kind === "openai" ? target.pathname !== "/v1/chat/completions" || target.search !== "" :
      !/^\/v1beta\/models\/gemini-(?:2\.5-(?:pro|flash(?:-lite)?)|3\.5-flash-lite):generateContent$/.test(target.pathname) || [...target.searchParams.keys()].some(k => k !== "key")) throw boundedFailure("endpoint_unsupported");
  return (registration.transport ?? fetch)(url, { ...init, redirect: "error" });
}
export function boundedHTTPFailure(status: number): Error {
  // HTTP failure is not a no-execution receipt. Even a quota-shaped response
  // cannot authorize releasing a financial hold or replaying an unknown call.
  return boundedFailure(status === 429 ? "provider_quota" : status >= 500 || status === 408 ? "provider_temporary" : "provider_rejected");
}
export function boundedMissingCredential(provider: XAIProvider, input: XAIInput): XAIResult {
  const result = Object.freeze({ text: "" }); receipts.set(result, { provider, input }); return result;
}
export function isBoundedNoExecution(provider: XAIProvider, result: unknown, input: XAIInput): boolean {
  if (!result || typeof result !== "object") return false;
  const proof = receipts.get(result);
  return proof?.provider === provider && proof.input === input;
}
