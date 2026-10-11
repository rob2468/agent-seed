import type {
  ChatCompletionMessage,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

export interface Model {
  reply(history: ChatCompletionMessageParam[]): Promise<ChatCompletionMessage>;
}

export type ToolResult =
  { ok: true; data: unknown } | { ok: false; error: string };
export type Execute = (
  call: ChatCompletionMessageFunctionToolCall,
) => Promise<ToolResult>;
