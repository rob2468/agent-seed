import type {
  ChatCompletionMessage,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

export interface ModelCallContext {
  turn: number;
  modelCall: number;
}

export interface Provider {
  reply(
    history: ChatCompletionMessageParam[],
    context: ModelCallContext,
  ): Promise<ChatCompletionMessage>;
}

export type ToolResult =
  { ok: true; data: unknown } | { ok: false; error: string };
export type Execute = (
  call: ChatCompletionMessageFunctionToolCall,
) => Promise<ToolResult>;
