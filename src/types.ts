import type {
  ChatCompletionMessage,
  ChatCompletionChunk,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

/**
 * 模型调用的日志标签，不发送给模型。
 */
export interface ModelCallContext {
  /**
   * 当前用户输入的轮次，按历史中的 user 消息数计算。
   */
  turn: number;
  /**
   * 当前轮次内第几次调用模型，从 1 开始；每次用户输入重新计数。
   */
  modelCall: number;
}

export interface Provider {
  /**
   * 重置会话用量基准。
   */
  reset?(): void;
  /**
   * 生成上下文摘要，不执行工具，也不修改原会话的用量基准。
   */
  summarize?(
    history: ChatCompletionMessageParam[],
    context: ModelCallContext,
    signal?: AbortSignal,
  ): Promise<ChatCompletionMessage>;
  /**
   * 请求模型，逐段产出 OpenAI 响应片段。
   */
  reply(
    history: ChatCompletionMessageParam[],
    context: ModelCallContext,
    signal?: AbortSignal,
  ): AsyncIterable<ChatCompletionChunk>;
}

export type ToolResult =
  { ok: true; data: unknown } | { ok: false; error: string };
/**
 * 展示写入内容并等待用户确认。
 */
export type ConfirmWrite = (
  path: string,
  content: string,
  overwrite: boolean,
  signal?: AbortSignal,
) => Promise<boolean>;

export type Execute = (
  call: ChatCompletionMessageFunctionToolCall,
  signal?: AbortSignal,
) => Promise<ToolResult>;

/**
 * Agent Loop 使用的会话状态。
 */
export interface AgentContext {
  provider: Provider;
  execute: Execute;
  history: ChatCompletionMessageParam[];
  maxModelCalls: number;
}

/**
 * 流式输出的类型。
 */
export const OUTPUT_TYPE = {
  /**
   * 逐段产出的文本，供终端显示。
   */
  TEXT: 'text',
  /**
   * 拼接完成的助手消息，供 Agent Loop 处理。
   */
  MESSAGE: 'message',
  /**
   * 本轮任务的最终结果，包含状态、回答和历史。
   */
  RESULT: 'result',
} as const;

/**
 * 流式拼接产出的正文增量和完整助手消息。
 */
export type ModelOutput =
  | { type: typeof OUTPUT_TYPE.TEXT; text: string }
  | { type: typeof OUTPUT_TYPE.MESSAGE; message: ChatCompletionMessage };
