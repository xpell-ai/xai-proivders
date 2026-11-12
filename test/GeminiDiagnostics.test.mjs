import assert from "node:assert/strict";
import test from "node:test";
import { GeminiProvider, readGeminiFailureDiagnostics, safeGeminiModel } from "../dist/gemini/index.js";

const originalFetch = globalThis.fetch;
const MODEL = "gemini-2.5-flash-lite";
const PRIVATE = "private-person@example.test prompt-and-response-content api_key=private-credential";
test.afterEach(() => { globalThis.fetch = originalFetch; });

for (const [status, providerStatus, expected] of [[429, "RESOURCE_EXHAUSTED", "provider_quota_or_rate_limit"], [503, "UNAVAILABLE", "provider_transient"]]) {
  test(`legacy Gemini ${status} retains only structured safe diagnostics`, async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: status, status: providerStatus, message: PRIVATE,
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1.500s", private: PRIVATE },
          { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ subject: PRIVATE }] }] }, private: PRIVATE }),
        { status, headers: { "content-type": "application/json", "retry-after": "12", "x-private": PRIVATE } });
    };
    const provider = new GeminiProvider({ apiKey: "private-provider-key", model: "gemini-2.5-flash" });
    await assert.rejects(() => provider.generate({ model: MODEL, prompt: PRIVATE }), error => {
      const d = readGeminiFailureDiagnostics(error);
      assert.equal(d._requested_model, MODEL); assert.equal(d._http_status, status);
      assert.equal(d._provider_code, status); assert.equal(d._provider_status, providerStatus);
      assert.equal(d._response_received, true); assert.equal(d._retry_after, "12"); assert.equal(d._retry_delay, "1.500s");
      assert.equal(d._classification, expected); assert.equal(d._execution_state, "outcome_uncertain"); assert.equal(d._upstream_cost, "unknown");
      assert.equal(new Date(d._occurred_at).toISOString(), d._occurred_at); assert.ok(Object.isFrozen(d));
      assert.doesNotMatch(error.message + JSON.stringify(error), /private-person|prompt-and-response|private-credential|private-provider-key|x-private|QuotaFailure/);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test("network timeout without an HTTP response does not imply no execution or zero cost", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Object.assign(new Error(PRIVATE), { name: "TimeoutError", code: "ETIMEDOUT", cause: new Error(PRIVATE) }); };
  await assert.rejects(() => new GeminiProvider({ apiKey: "synthetic", model: MODEL }).generate({ prompt: PRIVATE }), error => {
    const d = readGeminiFailureDiagnostics(error);
    assert.equal(d._response_received, false); assert.equal(d._http_status, null); assert.equal(d._provider_code, null);
    assert.equal(d._classification, "provider_timeout"); assert.equal(d._upstream_cost, "unknown");
    assert.equal(d._execution_state, "outcome_uncertain"); assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message + JSON.stringify(error), /private-person|prompt-and-response|private-credential/);
    return true;
  });
  assert.equal(calls, 1);
});

test("malformed Google error fields and retry values cannot become diagnostic strings", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: PRIVATE, status: PRIVATE, message: PRIVATE,
    details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: PRIVATE }] } }),
    { status: 503, headers: { "content-type": "application/json", "retry-after": PRIVATE } });
  await assert.rejects(() => new GeminiProvider({ apiKey: "synthetic", model: MODEL }).generate({ prompt: PRIVATE }), error => {
    const d = readGeminiFailureDiagnostics(error);
    assert.equal(d._http_status, 503); assert.equal(d._provider_code, null); assert.equal(d._provider_status, null);
    assert.equal(d._retry_after, null); assert.equal(d._retry_delay, null); assert.equal(d._classification, "provider_transient");
    assert.doesNotMatch(error.message + JSON.stringify(error), /private-person|prompt-and-response|private-credential/);
    return true;
  });
});

test("non-JSON response and body-read failures retain response receipt without retaining previews", async () => {
  for (const unreadable of [false, true]) {
    globalThis.fetch = async () => {
      const response = new Response(PRIVATE, { status: 502, headers: { "content-type": "text/html" } });
      if (unreadable) response.text = async () => { throw new Error(PRIVATE); };
      return response;
    };
    await assert.rejects(() => new GeminiProvider({ apiKey: "synthetic", model: MODEL }).generate({ prompt: PRIVATE }), error => {
      const d = readGeminiFailureDiagnostics(error);
      assert.equal(d._response_received, true); assert.equal(d._http_status, 502); assert.equal(error._code, "E_XAI_TRANSPORT_NON_JSON");
      assert.equal(error._details.preview, undefined); assert.equal(error._details.endpoint, undefined);
      assert.doesNotMatch(error.message + JSON.stringify(error), /private-person|prompt-and-response|private-credential/);
      return true;
    });
  }
});

test("success preserves the provider result and measured usage without diagnostics or retries", async () => {
  let calls = 0;
  const raw = { candidates: [{ content: { parts: [{ text: "mocked answer" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } };
  globalThis.fetch = async () => { calls++; return Response.json(raw); };
  const result = await new GeminiProvider({ apiKey: "synthetic", model: MODEL }).generate({ prompt: "synthetic" });
  assert.equal(calls, 1); assert.equal(result.text, "mocked answer"); assert.deepEqual(result.raw, raw);
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 4, total_tokens: 7 });
  assert.equal(readGeminiFailureDiagnostics(result), undefined);
});

test("a malformed successful response still reports receipt and uncertain cost", async () => {
  globalThis.fetch = async () => Response.json({ private: PRIVATE });
  await assert.rejects(() => new GeminiProvider({ apiKey: "synthetic", model: MODEL }).generate({ prompt: PRIVATE }), error => {
    const d = readGeminiFailureDiagnostics(error);
    assert.equal(d._http_status, 200); assert.equal(d._response_received, true);
    assert.equal(d._classification, "provider_response_invalid"); assert.equal(d._upstream_cost, "unknown");
    assert.doesNotMatch(error.message + JSON.stringify(error), /private-person|private-prompt|private-credential/);
    return true;
  });
});

test("diagnostic reader drops unknown fields and rejects sensitive model identifiers", async () => {
  assert.equal(safeGeminiModel(PRIVATE), null);
  globalThis.fetch = async () => new Response("{}", { status: 429 });
  await assert.rejects(() => new GeminiProvider({ apiKey: "synthetic", model: MODEL }).generate({ prompt: "synthetic" }), error => {
    const d = readGeminiFailureDiagnostics({ _gemini_diagnostics: { ...error._gemini_diagnostics, _private: PRIVATE,
      _requested_model: PRIVATE, _execution_state: "not_executed", _upstream_cost: "zero" } });
    assert.equal(d._requested_model, null); assert.equal(d._execution_state, "outcome_uncertain"); assert.equal(d._upstream_cost, "unknown");
    assert.equal(d._private, undefined); assert.equal(Object.keys(d).length, 13);
    return true;
  });
});
