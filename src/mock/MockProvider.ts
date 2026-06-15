import type { XAIProvider, XAIInput, XAIResult } from "@xpell/node";

export class MockProvider implements XAIProvider {
  async generate(input: XAIInput): Promise<XAIResult> {
    return {
      text: JSON.stringify({
        _id: "main",
        _type: "view",
        _children: [
          {
            _type: "label",
            _text: `AI says: ${input.prompt}`
          }
        ]
      })
    };
  }
}