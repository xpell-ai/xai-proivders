@xpell/xai-providers

Official AI provider implementations for the Xpell AI Runtime.

@xpell/xai-providers contains provider adapters that implement the XAIProvider interface used by @xpell/node and the XAI runtime.

The goal is to provide a consistent API across different AI backends while allowing Xpell applications, modules, and services to switch providers without changing business logic.

⸻

Installation

pnpm add @xpell/xai-providers

⸻

Available Providers

AzureProvider

Direct integration with Azure OpenAI deployments.

import { AzureProvider } from "@xpell/xai-providers/azure";

Supports:

* GPT-4o
* GPT-4o-mini
* GPT-5
* Azure OpenAI compatible deployments

⸻

AimeProvider

Integration with XAI Router.

Instead of talking directly to Azure/OpenAI, the provider sends requests to an XAI Router instance using an Xpell AI API Key.

import { AimeProvider } from "@xpell/xai-providers/aime";

Supports:

* XAI Router
* Usage tracking
* Token accounting
* Routing rules
* Centralized billing
* Multi-provider routing

⸻

MockProvider

Testing provider.

import { MockProvider } from "@xpell/xai-providers/mock";

Useful for:

* Unit tests
* Local development
* Runtime validation

⸻

Usage

Registering Providers

Providers are registered through the XAI runtime.

import { _xai } from "@xpell/node";
import { AzureProvider } from "@xpell/xai-providers/azure";
_xai.registerProvider(
  "azure",
  new AzureProvider({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
    apiKey: process.env.AZURE_OPENAI_API_KEY!,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT!,
  })
);

Set default provider:

await _x.execute({
  _module: "xai",
  _op: "set_default",
  _params: {
    _provider: "azure"
  }
});

⸻

Using AimeProvider

import { _xai } from "@xpell/node";
import { AimeProvider } from "@xpell/xai-providers/aime";
_xai.registerProvider(
  "aime",
  new AimeProvider({
    endpoint: process.env.AIME_ENDPOINT!,
    apiKey: process.env.AIME_API_KEY!,
  })
);

Set as default:

await _x.execute({
  _module: "xai",
  _op: "set_default",
  _params: {
    _provider: "aime"
  }
});

All XAI calls will now be routed through XAI Router.

⸻

XAIProvider Interface

Every provider implements:

interface XAIProvider {
  generate(
    input: XAIInput
  ): Promise<XAIResult>;
}

⸻

XAIInput

type XAIInput = {
  prompt: string;
  system?: string;
  context?: any;
  response_format?: {
    type: "text" | "json_object";
  };
};

⸻

XAIResult

type XAIUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};
type XAIResult = {
  text: string;
  raw?: unknown;
  usage?: XAIUsage;
};

⸻

Token Usage

Providers should return token usage whenever available.

Example:

{
  text: "Hello world",
  usage: {
    input_tokens: 14,
    output_tokens: 10,
    total_tokens: 24
  }
}

The XAI runtime, XVibe, XStudio, and XAI Router use this information for:

* telemetry
* analytics
* usage tracking
* billing
* routing decisions

⸻

Architecture

Application
      ↓
     XAI
      ↓
 XAIProvider
      ↓
 Provider API

Examples:

XVibe
 ↓
XAI
 ↓
AzureProvider
 ↓
Azure OpenAI
XVibe
 ↓
XAI
 ↓
AimeProvider
 ↓
XAI Router
 ↓
Azure/OpenAI/Anthropic

⸻

Project Goals

* Unified provider interface
* Runtime provider switching
* Token usage normalization
* Structured output support
* Provider-agnostic application code
* Seamless integration with XAI Router

⸻

License

Part of the Xpell AI ecosystem.

https://xpell.ai