import assert from "node:assert/strict";
import test from "node:test";
import { XAIModule } from "@xpell/node";
import {
  AimeProvider,
  AzureProvider,
  GeminiProvider,
  MockProvider,
  OpenAIProvider,
} from "../dist/index.js";

const original_fetch = globalThis.fetch;
const API_KEY = "test-provider-key";
const tools = [
  {
    _name: "get_sales_summary",
    _description: "Return sales totals for a date.",
    _input_schema: {
      type: "object",
      properties: {
        date: { type: "string" },
      },
      required: ["date"],
    },
  },
];

test.afterEach(() => {
  globalThis.fetch = original_fetch;
});

test("OpenAI maps native tools, named choice, multiple calls, IDs, and arguments", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.tools, [
      {
        type: "function",
        function: {
          name: "get_sales_summary",
          description: "Return sales totals for a date.",
          parameters: tools[0]._input_schema,
        },
      },
    ]);
    assert.deepEqual(body.tool_choice, {
      type: "function",
      function: { name: "get_sales_summary" },
    });
    assert.equal(body.messages[0].role, "user");
    assert.equal(body.messages[0].content, "What's today's sales total?");

    return jsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "openai-call-1",
                type: "function",
                function: {
                  name: "get_sales_summary",
                  arguments: JSON.stringify({ date: "today" }),
                },
              },
              {
                id: "openai-call-2",
                type: "function",
                function: {
                  name: "get_sales_summary",
                  arguments: JSON.stringify({ date: "yesterday" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        total_tokens: 19,
      },
    });
  };

  const result = await new OpenAIProvider({
    apiKey: API_KEY,
    model: "gpt-test",
  }).generate({
    prompt: "What's today's sales total?",
    tools,
    tool_choice: { _name: "get_sales_summary" },
  });

  assert.equal(result.text, "");
  assert.equal(result.finish_reason, "tool_calls");
  assert.equal(result.tool_calls.length, 2);
  assert.equal(result.tool_calls[0]._id, "openai-call-1");
  assert.equal(result.tool_calls[0]._name, "get_sales_summary");
  assert.deepEqual(result.tool_calls[0]._arguments, { date: "today" });
  assert.equal(result.usage.total_tokens, 19);
});

test("OpenAI preserves assistant tool-call and correlated tool-result messages", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.messages[1], {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "openai-call-1",
          type: "function",
          function: {
            name: "get_sales_summary",
            arguments: JSON.stringify({ date: "today" }),
          },
        },
      ],
    });
    assert.deepEqual(body.messages[2], {
      role: "tool",
      tool_call_id: "openai-call-1",
      content: JSON.stringify({ total: 1234 }),
    });

    return jsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "Today's sales total is 1,234.",
          },
          finish_reason: "stop",
        },
      ],
    });
  };

  const result = await new OpenAIProvider({
    apiKey: API_KEY,
    model: "gpt-test",
  }).generate({
    messages: tool_result_messages("openai-call-1"),
    tools,
    tool_choice: "auto",
  });

  assert.equal(result.text, "Today's sales total is 1,234.");
  assert.equal(result.finish_reason, "stop");
  assert.equal(result.tool_calls, undefined);
});

test("Gemini maps native declarations and returns normalized function calls", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.tools, [
      {
        functionDeclarations: [
          {
            name: "get_sales_summary",
            description: "Return sales totals for a date.",
            parameters: tools[0]._input_schema,
          },
        ],
      },
    ]);
    assert.deepEqual(body.toolConfig, {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["get_sales_summary"],
      },
    });

    return jsonResponse({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "gemini-provider-call-1",
                  name: "get_sales_summary",
                  args: { date: "today" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 9,
        candidatesTokenCount: 3,
        totalTokenCount: 12,
      },
    });
  };

  const result = await new GeminiProvider({
    apiKey: API_KEY,
    model: "gemini-test",
  }).generate({
    prompt: "What's today's sales total?",
    tools,
    tool_choice: { _name: "get_sales_summary" },
  });

  assert.equal(result.finish_reason, "tool_calls");
  assert.deepEqual(result.tool_calls, [
    {
      _id: "gemini-provider-call-1",
      _name: "get_sales_summary",
      _arguments: { date: "today" },
    },
  ]);
  assert.equal(result.usage.total_tokens, 12);
});

test("Gemini normalizes the closed conversation-stats schema without mutating it", async () => {
  const inputSchema = Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  });
  const conversationStatsTool = {
    _name: "agent.conversation_stats",
    _description: "Return conversation and message counts.",
    _input_schema: inputSchema,
  };

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const declaration = body.tools[0].functionDeclarations[0];

    assert.deepEqual(declaration, {
      name: "agent.conversation_stats",
      description: "Return conversation and message counts.",
      parameters: {
        type: "object",
        properties: {},
      },
    });
    assert.equal("additionalProperties" in declaration.parameters, false);

    return jsonResponse({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "gemini-conversation-stats-1",
                  name: "agent.conversation_stats",
                  args: {},
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    });
  };

  const result = await new GeminiProvider({
    apiKey: API_KEY,
    model: "gemini-2.5-flash",
  }).generate({
    prompt: "How many conversations do I have?",
    tools: [conversationStatsTool],
    tool_choice: "auto",
  });

  assert.deepEqual(inputSchema, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  assert.deepEqual(result.tool_calls, [
    {
      _id: "gemini-conversation-stats-1",
      _name: "agent.conversation_stats",
      _arguments: {},
    },
  ]);
});

test("Gemini recursively preserves supported schema fields and removes unsupported fields", async () => {
  const inputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    description: "Search options.",
    properties: {
      query: {
        type: "string",
        description: "Text to search for.",
        minLength: 1,
      },
      filters: {
        type: "object",
        description: "Optional filters.",
        properties: {
          limit: {
            type: "integer",
            description: "Maximum results.",
            minimum: 1,
            maximum: 100,
            exclusiveMinimum: true,
          },
          active: {
            type: "boolean",
            description: "Include active records.",
          },
        },
        required: ["limit"],
        additionalProperties: false,
      },
      tags: {
        type: "array",
        description: "Tags to match.",
        minItems: 1,
        items: {
          type: "string",
          description: "One tag.",
          enum: ["priority", "recent"],
          additionalProperties: false,
        },
      },
    },
    required: ["query", "filters"],
    additionalProperties: false,
    oneOf: [{ required: ["query"] }],
  };
  const originalSchema = structuredClone(inputSchema);

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const parameters = body.tools[0].functionDeclarations[0].parameters;

    assert.deepEqual(parameters, {
      type: "object",
      description: "Search options.",
      properties: {
        query: {
          type: "string",
          description: "Text to search for.",
          minLength: 1,
        },
        filters: {
          type: "object",
          description: "Optional filters.",
          properties: {
            limit: {
              type: "integer",
              description: "Maximum results.",
              minimum: 1,
              maximum: 100,
            },
            active: {
              type: "boolean",
              description: "Include active records.",
            },
          },
          required: ["limit"],
        },
        tags: {
          type: "array",
          description: "Tags to match.",
          minItems: 1,
          items: {
            type: "string",
            description: "One tag.",
            enum: ["priority", "recent"],
          },
        },
      },
      required: ["query", "filters"],
    });
    assert.equal(JSON.stringify(parameters).includes("additionalProperties"), false);
    assert.equal(JSON.stringify(parameters).includes("exclusiveMinimum"), false);
    assert.equal(JSON.stringify(parameters).includes("oneOf"), false);
    assert.equal(JSON.stringify(parameters).includes("$schema"), false);

    return jsonResponse({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "No tool needed." }],
          },
          finishReason: "STOP",
        },
      ],
    });
  };

  await new GeminiProvider({
    apiKey: API_KEY,
    model: "gemini-test",
  }).generate({
    prompt: "Search",
    tools: [
      {
        _name: "search_records",
        _description: "Search records.",
        _input_schema: inputSchema,
      },
    ],
  });

  assert.deepEqual(inputSchema, originalSchema);
});

test("Gemini correlates a tool result with the preceding assistant call ID", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.contents[1], {
      role: "model",
      parts: [
        {
          functionCall: {
            id: "gemini-call-1",
            name: "get_sales_summary",
            args: { date: "today" },
          },
        },
      ],
    });
    assert.deepEqual(body.contents[2], {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "get_sales_summary",
            response: { total: 1234 },
          },
        },
      ],
    });

    return jsonResponse({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Today's sales total is 1,234." }],
          },
          finishReason: "STOP",
        },
      ],
    });
  };

  const result = await new GeminiProvider({
    apiKey: API_KEY,
    model: "gemini-test",
  }).generate({
    messages: tool_result_messages("gemini-call-1"),
    tools,
    tool_choice: "auto",
  });

  assert.equal(result.text, "Today's sales total is 1,234.");
  assert.equal(result.finish_reason, "stop");
});

test("Azure OpenAI uses the native tools contract", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.tools[0].function.name, "get_sales_summary");
    assert.equal(body.tool_choice, "required");

    return jsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "azure-call-1",
                type: "function",
                function: {
                  name: "get_sales_summary",
                  arguments: JSON.stringify({ date: "today" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
  };

  const result = await new AzureProvider({
    endpoint: "https://azure.example.test",
    apiKey: API_KEY,
    deployment: "chat",
  }).generate({
    prompt: "sales",
    tools,
    tool_choice: "required",
  });

  assert.equal(result.tool_calls[0]._id, "azure-call-1");
  assert.equal(result.finish_reason, "tool_calls");
});

test("AIME preserves tools, choice, tool messages, normalized calls, finish reason, and usage", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const params = body._payload._params;
    assert.deepEqual(params._tools, tools);
    assert.equal(params._tool_choice, "auto");
    assert.equal(params._messages[1]._tool_calls[0]._id, "router-call-1");
    assert.equal(params._messages[2]._tool_call_id, "router-call-1");

    return jsonResponse({
      _payload: {
        _result: {
          _ok: true,
          _text: "",
          _tool_calls: [
            {
              _id: "router-call-1",
              _name: "get_sales_summary",
              _arguments: { date: "today" },
            },
            {
              _id: "router-call-2",
              _name: "get_sales_summary",
              _arguments: { date: "yesterday" },
            },
          ],
          _finish_reason: "tool_calls",
          _usage: {
            _input_tokens: 10,
            _output_tokens: 5,
            _total_tokens: 15,
            _reasoning_tokens: 2,
          },
        },
      },
    });
  };

  const result = await new AimeProvider({
    endpoint: "https://router.example.test",
    apiKey: API_KEY,
  }).generate({
    messages: tool_result_messages("router-call-1"),
    tools,
    tool_choice: "auto",
  });

  assert.equal(result.text, "");
  assert.equal(result.finish_reason, "tool_calls");
  assert.equal(result.tool_calls.length, 2);
  assert.equal(result.tool_calls[1]._id, "router-call-2");
  assert.equal(result.usage.reasoning_tokens, 2);
});

test("mocked XAI to AIME flow completes the two-generation sales tool loop", async () => {
  let generation = 0;
  globalThis.fetch = async (_url, init) => {
    generation += 1;
    const params = JSON.parse(init.body)._payload._params;

    if (generation === 1) {
      assert.deepEqual(params._tools, tools);
      assert.equal(params._messages[0]._content[0]._text, "What's today's sales total?");
      return jsonResponse({
        _payload: {
          _result: {
            _ok: true,
            _text: "",
            _tool_calls: [
              {
                _id: "sales-call-1",
                _name: "get_sales_summary",
                _arguments: { date: "today" },
              },
            ],
            _finish_reason: "tool_calls",
            _usage: {
              _input_tokens: 7,
              _output_tokens: 3,
              _total_tokens: 10,
            },
          },
        },
      });
    }

    assert.equal(params._messages[1]._tool_calls[0]._id, "sales-call-1");
    assert.equal(params._messages[2]._tool_call_id, "sales-call-1");
    assert.deepEqual(JSON.parse(params._messages[2]._content[0]._text), {
      total: 1234,
    });
    return jsonResponse({
      _payload: {
        _result: {
          _ok: true,
          _text: "Today's sales total is 1,234.",
          _finish_reason: "stop",
          _usage: {
            _input_tokens: 13,
            _output_tokens: 8,
            _total_tokens: 21,
          },
        },
      },
    });
  };

  const xai = new XAIModule();
  xai.registerProvider("aime", new AimeProvider({
    endpoint: "https://router.example.test",
    apiKey: API_KEY,
  }));

  const user_message = {
    _role: "user",
    _content: [
      {
        _type: "text",
        _text: "What's today's sales total?",
      },
    ],
  };
  const first = await xai._generate({
    _params: {
      _provider: "aime",
      _messages: [user_message],
      _tools: tools,
      _tool_choice: "auto",
    },
  });

  assert.equal(first._finish_reason, "tool_calls");
  assert.deepEqual(first._tool_calls[0]._arguments, { date: "today" });

  const application_tool_result = { total: 1234 };
  const second = await xai._generate({
    _params: {
      _provider: "aime",
      _messages: [
        user_message,
        {
          _role: "assistant",
          _content: [],
          _tool_calls: first._tool_calls,
        },
        {
          _role: "tool",
          _tool_call_id: first._tool_calls[0]._id,
          _content: [
            {
              _type: "text",
              _text: JSON.stringify(application_tool_result),
            },
          ],
        },
      ],
      _tools: tools,
      _tool_choice: "auto",
    },
  });

  assert.equal(second._text, "Today's sales total is 1,234.");
  assert.equal(second._finish_reason, "stop");
  assert.equal(generation, 2);
});

test("text-only mock provider fails clearly instead of emulating tools", async () => {
  await assert.rejects(
    () => new MockProvider().generate({
      prompt: "sales",
      tools,
    }),
    /E_XAI_TOOLS_UNSUPPORTED:mock/
  );
});

function tool_result_messages(call_id) {
  return [
    {
      _role: "user",
      _content: [
        {
          _type: "text",
          _text: "What's today's sales total?",
        },
      ],
    },
    {
      _role: "assistant",
      _content: [],
      _tool_calls: [
        {
          _id: call_id,
          _name: "get_sales_summary",
          _arguments: { date: "today" },
        },
      ],
    },
    {
      _role: "tool",
      _tool_call_id: call_id,
      _content: [
        {
          _type: "text",
          _text: JSON.stringify({ total: 1234 }),
        },
      ],
    },
  ];
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
