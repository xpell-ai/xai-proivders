import type { XAIInput, XAIToolCall } from "@xpell/node";

type Data = Record<string, any>;
export type GeminiContinuation = Readonly<{ _message_index: number; _parts: readonly Data[] }>;
const bound = new WeakMap<XAIInput, readonly GeminiContinuation[]>();
const fail = (): never => { throw Object.assign(new Error("request_unsupported"), { _classification: "request_unsupported" }); };
const object = (v: any): v is Data => !!v && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const only = (v: Data, fields: string[]) => Object.keys(v).every(k => fields.includes(k));
const toolName = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;
/** Provider wire names are limited to the intersection of Google's
 * declaration, call and response grammars. Inversion uses the approved list. */
export function geminiWireToolName(name: string): string {
  if (typeof name !== "string" || !toolName.test(name)) return fail();
  return name.replace(/[.:]/g, "_");
}
const callId = /^[A-Za-z0-9_.:-]{1,128}$/;
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// The measured Owner routing request is 22,636 bytes and contains a 10 KiB
// flattened prompt. Leave room for server metadata without raising token bounds.
const MAX_CONVERSATION_BYTES = 24 * 1024;
const MAX_TEXT_BYTES = 12 * 1024;
// Ordinary Pulse Owner chat presents 18 already-authorized declarations.
const MAX_TOOL_DECLARATIONS = 24;
const MAX_CALLS_PER_MESSAGE = 4;
export const GEMINI_35_FLASH_LITE = "gemini-3.5-flash-lite";
export function geminiConversationThinkingLevel(reasoning: unknown): "MINIMAL" | "MEDIUM" {
  if (reasoning === undefined || reasoning === "none" || reasoning === "minimal") return "MINIMAL";
  if (reasoning === "medium") return "MEDIUM";
  return fail();
}
const budgets: Record<string, number> = { none: 0, minimal: 1024, low: 1024, medium: 8192, high: 24576 };
export function geminiConversationThinkingBudget(reasoning: unknown, model?: string): number {
  const pro = model === "gemini-2.5-pro";
  if (reasoning === undefined) return pro ? -1 : 0;
  if (typeof reasoning !== "string" || !Object.hasOwn(budgets, reasoning)) return fail();
  if (pro && reasoning === "none") return fail();
  return budgets[reasoning];
}

function validateJSON(value: unknown, depth = 0): void {
  if (depth > 12) fail();
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (typeof value === "string") { if (Buffer.byteLength(value) > MAX_TEXT_BYTES) fail(); return; }
  if (Array.isArray(value)) {
    if (value.length > 64) fail();
    for (const item of value) validateJSON(item, depth + 1);
    return;
  }
  if (!object(value) || Object.keys(value).length > 64) return fail();
  for (const [key, item] of Object.entries(value)) {
    if (Buffer.byteLength(key) > 128 || ["__proto__", "prototype", "constructor"].includes(key)) fail();
    validateJSON(item, depth + 1);
  }
}

export function validateBoundedGeminiConversation(input: XAIInput) {
  validateJSON(input);
  if (!only(input, ["model","prompt","system","max_tokens","response_format","metadata","messages","context","reasoning","tools","tool_choice"]) ||
      Buffer.byteLength(JSON.stringify(input)) > MAX_CONVERSATION_BYTES || !Array.isArray(input.messages) ||
      input.messages.length < 1 || input.messages.length > 32 ||
      (input.system !== undefined && typeof input.system !== "string") ||
      (input.context !== undefined && !object(input.context)) ||
      (input.response_format !== undefined && (!object(input.response_format) || !only(input.response_format, ["type"]) ||
        !["text","json_object"].includes(input.response_format.type)))) fail();
  const lite = input.model === GEMINI_35_FLASH_LITE;
  const budget = lite ? 0 : geminiConversationThinkingBudget(input.reasoning, input.model);
  if (lite) {
    geminiConversationThinkingLevel(input.reasoning);
    if ([...input.messages!].reverse().find(message => message?._role !== "system")?._role === "assistant") fail();
  }
  const pro = input.model === "gemini-2.5-pro";
  if (!Number.isSafeInteger(input.max_tokens) || input.max_tokens! < (pro ? 128 : 1) ||
      input.max_tokens! > (pro ? 65536 : 4096) || budget > input.max_tokens!) fail();
  const tools = input.tools ?? [];
  if (!Array.isArray(tools) || tools.length > MAX_TOOL_DECLARATIONS || (tools.length > 0 && input.response_format?.type === "json_object")) fail();
  const names = new Set<string>(), aliases = new Map<string, string>();
  for (const tool of tools) {
    if (!object(tool) || !only(tool, ["_name","_description","_input_schema"]) || typeof tool._name !== "string" ||
        !toolName.test(tool._name) || names.has(tool._name) ||
        (tool._description !== undefined && typeof tool._description !== "string") ||
        !object(tool._input_schema) || tool._input_schema.type !== "object") fail();
    const alias = geminiWireToolName(tool._name);
    if (aliases.has(alias)) fail();
    aliases.set(alias, tool._name);
    names.add(tool._name);
  }
  const choice = input.tool_choice;
  if (choice !== undefined && (!(choice === "auto" || choice === "none" || choice === "required" ||
      (object(choice) && only(choice, ["_name"]) && names.has(choice._name))) || !tools.length)) fail();
  const calls: Array<{_message_index: number; _call: XAIToolCall}> = [];
  let pending: readonly XAIToolCall[] = [], resultIndex = 0;
  for (const [index, message] of input.messages!.entries()) {
    if (!object(message) || !["system","user","assistant","tool"].includes(message._role) ||
        !only(message, ["_role","_content", ...(message._role === "tool" ? ["_tool_call_id"] : message._role === "assistant" ? ["_tool_calls"] : [])]) ||
        !Array.isArray(message._content) || message._content.length > 8 ||
        message._content.some(part => !object(part) || !only(part, ["_type","_text"]) || part._type !== "text" || typeof part._text !== "string")) fail();
    const expected = pending[resultIndex];
    if (expected && (message._role !== "tool" || message._tool_call_id !== expected._id)) fail();
    if (message._role === "tool") {
      if (!expected || message._content.length !== 1) fail();
      resultIndex += 1;
    } else if (message._role === "assistant" && message._tool_calls !== undefined) {
      if (!Array.isArray(message._tool_calls) || message._tool_calls.length < 1 ||
          message._tool_calls.length > MAX_CALLS_PER_MESSAGE) fail();
      const ids = new Set<string>();
      for (const call of message._tool_calls) {
        if (!object(call) || !only(call, ["_id","_name","_arguments","_continuation_ref"]) ||
            typeof call._id !== "string" || !callId.test(call._id) || ids.has(call._id) ||
            typeof call._name !== "string" || !toolName.test(call._name) || !object(call._arguments) ||
            typeof call._continuation_ref !== "string" || !reference.test(call._continuation_ref) ||
            call._continuation_ref !== message._tool_calls[0]._continuation_ref) fail();
        const alias = geminiWireToolName(call._name), declared = aliases.get(alias);
        if (declared !== undefined && declared !== call._name) fail();
        aliases.set(alias, call._name);
        ids.add(call._id);
        calls.push({_message_index: index, _call: call});
      }
      pending = message._tool_calls;
      resultIndex = 0;
    } else if (!message._content.length) fail();
  }
  if (pending[resultIndex] || !input.messages!.some(message => message._role === "user")) fail();
  return calls;
}

export function bindBoundedGeminiConversation(input: XAIInput, continuations: readonly GeminiContinuation[]) {
  const history = validateBoundedGeminiConversation(input);
  const indexes = [...new Set(history.map(call => call._message_index))];
  if (indexes.length !== continuations.length) fail();
  for (const [index, messageIndex] of indexes.entries()) {
    const continuation = continuations[index];
    if (continuation._message_index !== messageIndex) fail();
    const calls = history.filter(call => call._message_index === messageIndex);
    const parts = continuation._parts.filter(part => part.functionCall !== undefined);
    if (parts.length !== calls.length || calls.some(({_call: call}, partIndex) => {
      const functionCall = parts[partIndex].functionCall;
      return functionCall?.name !== geminiWireToolName(call._name) ||
        (functionCall?.id !== undefined && functionCall.id !== call._id);
    })) fail();
  }
  if (Buffer.byteLength(JSON.stringify(input)) + Buffer.byteLength(JSON.stringify(continuations)) > MAX_CONVERSATION_BYTES) fail();
  bound.set(input, continuations);
}
export function boundedGeminiConversation(input: XAIInput) { return bound.get(input); }
