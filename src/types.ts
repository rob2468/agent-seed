import type {
  ChatCompletionMessage,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

/**
 * 本次模型调用的日志标记，由 Agent Loop 传给 Provider。
 * 仅写入日志标签区，不加入发送给模型的请求正文。
 */
export interface ModelCallContext {
  /**
   * 当前用户输入的轮次，从 1 开始；清空历史后重新计数。
   */
  turn: number;
  /**
   * 当前轮次内第几次调用模型，从 1 开始；每次用户输入重新计数。
   */
  modelCall: number;
}

export interface Provider {
  /**
   * 清空会话时重置本地用量基准；无状态 Provider 可不实现。
   */
  reset?(): void;
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
