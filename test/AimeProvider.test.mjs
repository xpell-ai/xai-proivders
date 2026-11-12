import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { XAIModule } from "@xpell/node";
import { AimeProvider } from "../dist/aime/index.js";
import { GeminiProvider } from "../dist/gemini/index.js";

const original_fetch = globalThis.fetch;
const API_KEY = "xair_sk_test_abcdefghijklmnopqrstuvwxyzABCDEF";
const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const PDF_SHA256 = createHash("sha256").update(PDF_BYTES).digest("hex");

test.afterEach(() => {
  globalThis.fetch = original_fetch;
});

test("generate still calls Router generate with the configured XAI key", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body);
    assert.equal(body._payload._op, "generate");
    assert.equal(body._payload._params._api_key, API_KEY);
    assert.equal(body._payload._params._task, "gator-council");
    assert.equal(body._payload._params._caller_module, "gator-council");
    assert.equal(body._payload._params._caller_op, "run-round_1");
    assert.equal(body._payload._params._idempotency_key, "idem-aime-1");
    assert.equal(body._payload._params._prompt, "hello");
    assert.equal(body._payload._params._messages, undefined);
    assert.equal(body._payload._params._purpose, undefined);
    assert.equal(body._payload._params.private_key, undefined);
    return jsonResponse({
      _payload: {
        _result: {
          _ok: true,
          _text: "generated text",
          _usage: {
            _input_tokens: 1,
            _output_tokens: 2,
            _total_tokens: 3,
          },
        },
      },
    });
  };

  const provider = new AimeProvider({
    endpoint: "https://router.example.test",
    apiKey: API_KEY,
  });
  const result = await provider.generate({
    prompt: "hello",
    _task: "gator-council",
    metadata: {
      _caller_module: "gator-council",
      _caller_op: "run-round_1",
      _idempotency_key: "idem-aime-1",
      private_key: "must-not-forward",
    },
  });

  assert.equal(result.text, "generated text");
  assert.equal(result.usage.total_tokens, 3);
  assert.equal(calls.length, 1);
});

test("role-aware chat messages survive XAI and Aime at the Router boundary", async () => {
  const messages = [
    {
      _role: "user",
      _content: [
        {
          _type: "text",
          _text: "Do you have vegan food?",
        },
      ],
    },
    {
      _role: "assistant",
      _content: [
        {
          _type: "text",
          _text: "Yes, we have vegan options.",
        },
      ],
    },
    {
      _role: "user",
      _content: [
        {
          _type: "text",
          _text: "And what time do you close?",
        },
      ],
    },
  ];

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const params = body._payload._params;

    assert.equal(body._payload._op, "generate");
    assert.equal(params._system, "You are a business assistant.");
    assert.deepEqual(params._messages, messages);
    assert.equal(
      params._prompt,
      [
        "Do you have vegan food?",
        "Yes, we have vegan options.",
        "And what time do you close?",
      ].join("\n")
    );
    assert.equal(params._task, "chat");
    assert.equal(params._model, "router-chat-model");
    assert.equal(params._idempotency_key, "idem-role-chat-1");

    return jsonResponse({
      _payload: {
        _result: {
          _ok: true,
          _text: "We close at 10 PM.",
          _provider: "openai",
          _model: "router-chat-model",
          _task: "chat",
          _usage: {
            _input_tokens: 20,
            _output_tokens: 6,
            _total_tokens: 26,
          },
        },
      },
    });
  };

  const xai = new XAIModule();
  xai.registerProvider(
    "aime",
    new AimeProvider({
      endpoint: "https://router.example.test",
      apiKey: API_KEY,
    })
  );

  const result = await xai._generate({
    _params: {
      _provider: "aime",
      _messages: messages,
      system: "You are a business assistant.",
      _task: "chat",
      _model: "router-chat-model",
      _idempotency_key: "idem-role-chat-1",
    },
  });

  assert.equal(result._ok, true);
  assert.equal(result._text, "We close at 10 PM.");
  assert.deepEqual(result._usage, {
    input_tokens: 20,
    output_tokens: 6,
    total_tokens: 26,
  });
});

test("messages take precedence over prompt without concatenation", async () => {
  const messages = [
    {
      _role: "system",
      _content: [
        {
          _type: "text",
          _text: "Use the structured conversation.",
        },
      ],
    },
    {
      _role: "user",
      _content: [
        {
          _type: "text",
          _text: "Structured request",
        },
      ],
    },
  ];

  globalThis.fetch = async (_url, init) => {
    const params = JSON.parse(init.body)._payload._params;
    assert.equal(
      params._prompt,
      "Use the structured conversation.\nStructured request"
    );
    assert.deepEqual(params._messages, messages);
    assert.equal(params._system, undefined);

    return jsonResponse({
      _payload: {
        _result: {
          _ok: true,
          _text: "structured response",
        },
      },
    });
  };

  const provider = new AimeProvider({
    endpoint: "https://router.example.test",
    apiKey: API_KEY,
  });

  const result = await provider.generate({
    prompt: "This prompt must not be concatenated.",
    messages,
  });

  assert.equal(result.text, "structured response");
});

test("generate rejects malformed message input before calling Router", async () => {
  let fetch_calls = 0;
  globalThis.fetch = async () => {
    fetch_calls += 1;
    throw new Error("Router must not be called");
  };

  const provider = new AimeProvider({
    endpoint: "https://router.example.test",
    apiKey: API_KEY,
  });

  await assert.rejects(
    () => provider.generate({
      messages: {},
    }),
    /E_XAI_MESSAGES_INVALID/
  );

  await assert.rejects(
    () => provider.generate({
      messages: [
        {
          _role: "invalid",
          _content: [
            {
              _type: "text",
              _text: "invalid role",
            },
          ],
        },
      ],
    }),
    /E_XAI_MESSAGE_ROLE_INVALID/
  );

  assert.equal(fetch_calls, 0);
});

test("recoverGeneration calls Router recover_generation through the provider boundary", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body);
    assert.equal(body._payload._op, "recover_generation");
    assert.equal(body._payload._params._api_key, API_KEY);
    assert.equal(body._payload._params._idempotency_key, "idem-recover-1");
    return jsonResponse({
      _payload: {
        _result: {
          _ok: true,
          _state: "success",
          _idempotency_key: "idem-recover-1",
          _provider: "gemini",
          _model: "gemini-2.5-flash",
          _result: {
            _text: "recovered text",
          },
          _usage: {
            _input_tokens: 1,
            _output_tokens: 2,
            _total_tokens: 3,
          },
          _billing: {
            _status: "debited",
          },
          _completed_at: "2026-09-23T00:00:00.000Z",
        },
      },
    });
  };

  const provider = new AimeProvider({
    endpoint: "https://router.example.test",
    apiKey: API_KEY,
  });

  const recovered = await provider.recoverGeneration({
    _idempotency_key: "idem-recover-1",
  });

  assert.equal(recovered._state, "success");
  assert.equal(recovered._result._text, "recovered text");
  assert.equal(calls.length, 1);
});

test("generate unwraps live Wormholes XResponse payload before reading generated text", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body._payload._op, "generate");
    assert.equal(body._payload._params._api_key, API_KEY);
    return jsonResponse({
      _v: 2,
      _kind: "RES",
      _payload: {
        _ok: true,
        _result: {
          _ok: true,
          _text: "{\"status\":\"ok\"}",
          _provider: "gemini",
          _model: "gemini-2.5-flash",
          _task: "chat",
          _usage: {
            _input_tokens: 4,
            _output_tokens: 5,
            _total_tokens: 9,
          },
        },
      },
    });
  };

  const provider = new AimeProvider({
    endpoint: "https://router.example.test",
    apiKey: API_KEY,
  });

  const result = await provider.generate({
    prompt: "Return only JSON",
    response_format: { type: "json_object" },
  });

  assert.equal(result.text, "{\"status\":\"ok\"}");
  assert.deepEqual(JSON.parse(result.text), { status: "ok" });
  assert.equal(result.usage.input_tokens, 4);
  assert.equal(result.usage.output_tokens, 5);
  assert.equal(result.usage.total_tokens, 9);
  assert.equal(result.raw._provider, "gemini");
  assert.equal(result.raw._model, "gemini-2.5-flash");
});

test("generate rejects non-JSON Router responses with diagnostics", async () => {
  globalThis.fetch = async () => textResponse(
    "<!DOCTYPE html><html><body>login token=abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz</body></html>",
    200,
    "text/html; charset=utf-8"
  );

  const provider = new AimeProvider({
    endpoint: "https://router.example.test",
    apiKey: API_KEY,
  });

  await assert.rejects(
    () => provider.generate({
      prompt: "hello",
      model: "router-model",
    }),
    (err) => {
      assert.equal(err._code, "E_XAI_TRANSPORT_NON_JSON");
      assert.equal(err._details.status, 200);
      assert.equal(err._details.content_type, "text/html; charset=utf-8");
      assert.equal(err._details.endpoint, "https://router.example.test/wh/v2/call");
      assert.equal(err._details.provider, "xai-router");
      assert.equal(err._details.model, "router-model");
      assert.match(err._details.preview, /^<!DOCTYPE html>/);
      assert.doesNotMatch(err.message, /abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz/);
      return true;
    }
  );
});

test("generate preserves nested Router provider diagnostics", async () => {
  globalThis.fetch = async () => jsonResponse({
    _payload: {
      _ok: true,
      _result: {
        _ok: false,
        _error: {
          _code: "E_XAI_PROVIDER_GENERATE_FAILED",
          _message: "AI provider request failed",
          _details: {
            _error_message: "Gemini generateContent returned non-JSON response (status=502, content_type=text/html, endpoint=https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=[redacted], provider=gemini, model=gemini-2.5-flash, preview=<!DOCTYPE html>)",
          },
        },
      },
    },
  });

  const provider = new AimeProvider({
    endpoint: "https://router.example.test",
    apiKey: API_KEY,
  });

  await assert.rejects(
    () => provider.generate({
      prompt: "hello",
    }),
    /Gemini generateContent returned non-JSON response/
  );
});

test("Gemini rejects non-JSON responses with sanitized diagnostics", async () => {
  globalThis.fetch = async () => textResponse(
    "<!DOCTYPE html><html><body>proxy login token=abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz</body></html>",
    502,
    "text/html"
  );

  const provider = new GeminiProvider({
    apiKey: API_KEY,
    model: "gemini-2.5-flash",
  });

  await assert.rejects(
    () => provider.generate({
      prompt: "hello",
    }),
    (err) => {
      assert.equal(err._code, "E_XAI_TRANSPORT_NON_JSON");
      assert.equal(err._details.status, 502);
      assert.equal(err._details.content_type, "text/html");
      assert.equal(err._details.provider, "gemini");
      assert.equal(err._details.model, "gemini-2.5-flash");
      assert.equal(err._details.endpoint, undefined);
      assert.equal(err._details.preview, undefined);
      assert.equal(err._gemini_diagnostics._response_received, true);
      assert.doesNotMatch(JSON.stringify(err), /proxy login|abcdefghijklmnopqrstuvwxyz/);
      assert.doesNotMatch(err.message, /abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz/);
      return true;
    }
  );
});

test("Gemini forwards high reasoning as 2.5 thinking budget and records returned thought tokens", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      candidates: [
        {
          content: {
            parts: [
              {
                text: "reasoned answer",
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 11,
        candidatesTokenCount: 7,
        totalTokenCount: 42,
        thoughtsTokenCount: 24,
      },
    });
  };

  const provider = new GeminiProvider({
    apiKey: API_KEY,
    model: "gemini-2.5-pro",
  });
  const result = await provider.generate({
    prompt: "think carefully",
    reasoning: "high",
  });

  const body = JSON.parse(calls[0].init.body);
  assert.equal(
    calls[0].url,
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${encodeURIComponent(API_KEY)}`
  );
  assert.deepEqual(body.generationConfig.thinkingConfig, {
    thinkingBudget: 24576,
  });
  assert.equal(result.text, "reasoned answer");
  assert.equal(result.usage.input_tokens, 11);
  assert.equal(result.usage.output_tokens, 7);
  assert.equal(result.usage.total_tokens, 42);
  assert.equal(result.usage.reasoning_tokens, 24);
});

test("generate normalizes Router structured object result for json_object requests", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body._payload._op, "generate");
    assert.equal(body._payload._params._response_format.type, "json_object");
    return jsonResponse({
      _v: 2,
      _kind: "RES",
      _payload: {
        _ok: true,
        _result: {
          _ok: true,
          _object: {
            metadata: {
              document_type: "ENFORCEMENT_AUTHORITY_DECISION",
            },
            facts: [],
            warnings: [],
          },
          _provider: "aime",
          _model: "router-structured",
          _usage: {
            _input_tokens: 10,
            _output_tokens: 20,
            _total_tokens: 30,
          },
        },
      },
    });
  };

  const provider = new AimeProvider({
    endpoint: "https://router.example.test",
    apiKey: API_KEY,
  });

  const result = await provider.generate({
    prompt: "Return only JSON",
    response_format: { type: "json_object" },
  });

  assert.deepEqual(JSON.parse(result.text), {
    metadata: {
      document_type: "ENFORCEMENT_AUTHORITY_DECISION",
    },
    facts: [],
    warnings: [],
  });
  assert.equal(result.usage.total_tokens, 30);
});

test("generate forwards model and reasoning overrides to Router", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body._payload._op, "generate");
    assert.equal(body._payload._params._model, "router-supported-model");
    assert.equal(body._payload._params._reasoning, "high");
    return jsonResponse({
      _payload: {
        _ok: true,
        _result: {
          _ok: true,
          _text: "ok",
          _model: "router-supported-model",
        },
      },
    });
  };

  const provider = new AimeProvider({
    endpoint: "https://router.example.test",
    apiKey: API_KEY,
  });

  const result = await provider.generate({
    prompt: "hello",
    model: "router-supported-model",
    reasoning: "high",
  });

  assert.equal(result.text, "ok");
});

test("structured object responses work through XAI generate_object", async () => {
  globalThis.fetch = async () => jsonResponse({
    _payload: {
      _ok: true,
      _result: {
        _ok: true,
        _object: {
          ok: true,
          source: "aime-structured",
        },
      },
    },
  });

  const xai = new XAIModule();
  xai.registerProvider(
    "aime",
    new AimeProvider({
      endpoint: "https://router.example.test",
      apiKey: API_KEY,
    })
  );

  const result = await xai._generate_object({
    _params: {
      _provider: "aime",
      _prompt: "Return only JSON",
    },
  });

  assert.equal(result._ok, true);
  assert.deepEqual(result._object, {
    ok: true,
    source: "aime-structured",
  });
});

test("generate normalizes direct JSON object result for json_object requests", async () => {
  globalThis.fetch = async () => jsonResponse({
    _payload: {
      _ok: true,
      _result: {
        metadata: {
          document_type: "UNKNOWN",
        },
        facts: [],
        warnings: ["review required"],
      },
    },
  });

  const provider = new AimeProvider({
    endpoint: "https://router.example.test",
    apiKey: API_KEY,
  });

  const result = await provider.generate({
    prompt: "Return only JSON",
    response_format: { type: "json_object" },
  });

  assert.deepEqual(JSON.parse(result.text), {
    metadata: {
      document_type: "UNKNOWN",
    },
    facts: [],
    warnings: ["review required"],
  });
});

test("generate preserves clear failure for nested Router errors", async () => {
  globalThis.fetch = async () => jsonResponse({
    _payload: {
      _ok: true,
      _result: {
        _ok: false,
        _error: {
          _code: "E_PROVIDER_EMPTY",
          _message: "empty model response",
        },
      },
    },
  });

  const provider = new AimeProvider({
    endpoint: "https://router.example.test",
    apiKey: API_KEY,
  });

  await assert.rejects(
    () => provider.generate({
      prompt: "Return only JSON",
      response_format: { type: "json_object" },
    }),
    /Aime provider generate failed \(E_PROVIDER_EMPTY\): empty model response/
  );
});

test("generate still rejects empty successful responses", async () => {
  globalThis.fetch = async () => jsonResponse({
    _payload: {
      _ok: true,
      _result: {
        _ok: true,
      },
    },
  });

  const provider = new AimeProvider({
    endpoint: "https://router.example.test",
    apiKey: API_KEY,
  });

  await assert.rejects(
    () => provider.generate({
      prompt: "Return only JSON",
      response_format: { type: "json_object" },
    }),
    /Aime provider response missing generated text/
  );
});

test("extractDocument resolves local xpell-file-ref, uploads bytes, and calls Router extract_document", async () => {
  let resolved = false;
  const calls = [];
  const router_file_ref = {
    _type: "xai-file-ref",
    _id: "xai_file_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    _mime_type: "application/pdf",
    _filename: "fixture.pdf",
    _size_bytes: PDF_BYTES.length,
    _sha256: PDF_SHA256,
    _created_at: "2026-09-13T00:00:00.000Z",
    _expires_at: "2026-09-13T01:00:00.000Z",
  };

  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });

    if (String(url).endsWith("/xai-router/v1/files")) {
      assert.equal(init.method, "POST");
      assert.equal(init.headers.authorization, `Bearer ${API_KEY}`);
      assert.equal(init.headers["x-xai-document-sha256"], PDF_SHA256);
      assert.notEqual(typeof init.body, "string");
      assert.equal(init.body instanceof FormData, true);

      const uploaded = init.body.get("file");
      assert.equal(uploaded.name, "fixture.pdf");
      assert.equal(uploaded.type, "application/pdf");
      assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), PDF_BYTES);

      return jsonResponse({
        _ok: true,
        _result: {
          file_ref: router_file_ref,
        },
      }, 201);
    }

    assert.equal(String(url).endsWith("/wh/v2/call"), true);
    assert.equal(init.headers["content-type"], "application/json");
    const body = JSON.parse(init.body);
    assert.equal(body._payload._op, "extract_document");
    assert.equal(body._payload._params._api_key, API_KEY);
    assert.deepEqual(body._payload._params.document.file_ref, router_file_ref);
    assert.equal(init.body.includes(PDF_BYTES.toString("base64")), false);
    assert.equal(init.body.includes("%PDF"), false);
    assert.equal(init.body.includes("_absolute_path"), false);

    return jsonResponse({
      _payload: {
        _result: {
          _ok: true,
          _result: {
            provider: "router-test",
            text: "",
            page_count: 0,
            pages: [],
            spans: [],
          },
        },
      },
    });
  };

  const provider = new AimeProvider({
    endpoint: "https://router.example.test/",
    apiKey: API_KEY,
    resolveFileRef: async (file_ref, requirements) => {
      resolved = true;
      assert.equal(file_ref._type, "xpell-file-ref");
      assert.equal(requirements._app_id, "gator");
      assert.equal(requirements._env, "test");
      assert.equal(requirements._accepted_mime_types.includes("application/pdf"), true);
      return {
        _filename: "fixture.pdf",
        _mime_type: "application/pdf",
        _size_bytes: PDF_BYTES.length,
        _sha256: PDF_SHA256,
        _bytes: PDF_BYTES,
      };
    },
  });

  assert.equal(typeof provider.extractDocument, "function");
  const result = await provider.extractDocument({
    file_ref: xpellPdfRef(),
    options: {
      include_geometry: true,
    },
  });

  assert.equal(resolved, true);
  assert.equal(result.provider, "router-test");
  assert.equal(calls.length, 2);
});

test("extractDocument rejects arbitrary local paths before fetch", async () => {
  let fetch_called = false;
  globalThis.fetch = async () => {
    fetch_called = true;
    return jsonResponse({});
  };

  const provider = new AimeProvider({
    endpoint: "https://router.example.test",
    apiKey: API_KEY,
    resolveFileRef: async () => {
      throw new Error("resolver should not be called");
    },
  });

  await assert.rejects(
    () => provider.extractDocument({
      file_ref: {
        ...xpellPdfRef(),
        _path: "/tmp/fixture.pdf",
      },
    }),
    /local path field/
  );
  assert.equal(fetch_called, false);
});

test("extractDocument forwards Router-ready xai-file-ref without upload", async () => {
  const router_file_ref = {
    _type: "xai-file-ref",
    _id: "xai_file_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    _mime_type: "application/pdf",
    _filename: "fixture.pdf",
    _size_bytes: PDF_BYTES.length,
    _sha256: PDF_SHA256,
    _created_at: "2026-09-13T00:00:00.000Z",
    _expires_at: "2026-09-13T01:00:00.000Z",
  };
  const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    const body = JSON.parse(init.body);
    assert.deepEqual(body._payload._params.document.file_ref, router_file_ref);
    return jsonResponse({
      _payload: {
        _result: {
          _ok: true,
          _result: {
            provider: "router-test",
            text: "",
            page_count: 0,
            pages: [],
            spans: [],
          },
        },
      },
    });
  };

  const provider = new AimeProvider({
    endpoint: "https://router.example.test",
    apiKey: API_KEY,
  });

  await provider.extractDocument({
    file_ref: router_file_ref,
  });

  assert.deepEqual(urls, ["https://router.example.test/wh/v2/call"]);
});

function xpellPdfRef() {
  return {
    _type: "xpell-file-ref",
    _version: 1,
    _id: "file_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    _scope: "temp",
    _app_id: "gator",
    _env: "test",
    _filename: "fixture.pdf",
    _mime_type: "application/pdf",
    _size_bytes: PDF_BYTES.length,
    _sha256: PDF_SHA256,
    _created_at: "2026-09-13T00:00:00.000Z",
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({
      "content-type": "application/json; charset=utf-8",
    }),
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

function textResponse(body, status, contentType) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({
      "content-type": contentType,
    }),
    async text() {
      return body;
    },
  };
}

test('caller output limit accompanies existing context through AIME', async () => {
  globalThis.fetch = async (_url, init) => {
    const params = JSON.parse(init.body)._payload._params;
    assert.equal(params._max_tokens, 80);
    assert.deepEqual(params._context, { _application: { public_fact: 'synthetic' } });
    return jsonResponse({ _payload: { _result: { _ok: true, _text: 'Fixture reply' } } });
  };
  await new AimeProvider({ endpoint: 'https://router.example.test', apiKey: API_KEY }).generate({
    prompt: 'Fixture', max_tokens: 80, context: { _application: { public_fact: 'synthetic' } },
  });
});
