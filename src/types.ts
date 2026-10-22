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

/**
 * 请求和压缩操作的预期结果。
 */
export const REQUEST_STATUS = {
  /**
   * 操作已完成。
   */
  COMPLETED: 'completed',
  /**
   * 本地预算不足，请求尚未发送。
   */
  BUDGET_EXCEEDED: 'budget_exceeded',
  /**
   * 用户取消操作。
   */
  CANCELLED: 'cancelled',
  /**
   * 操作失败，附带具体原因。
   */
  FAILED: 'failed',
} as const;

/**
 * 请求失败的具体原因。
 */
export const REQUEST_FAILURE = {
  /**
   * 模型请求超时。
   */
  TIMEOUT: 'timeout',
  /**
   * 模型连接建立失败或连接中断。
   */
  CONNECTION: 'connection',
  /**
   * 模型接口返回错误。
   */
  API: 'api',
  /**
   * 服务端拒绝超出上下文窗口的请求。
   */
  CONTEXT_LIMIT: 'context_limit',
  /**
   * 模型响应不完整或内容无效。
   */
  INVALID_RESPONSE: 'invalid_response',
} as const;

/**
 * 操作未完成的原因；message 可直接显示，不包含认证信息。
 */
export type StopResult =
  | { status: typeof REQUEST_STATUS.CANCELLED }
  | { status: typeof REQUEST_STATUS.BUDGET_EXCEEDED; message: string }
  | {
      status: typeof REQUEST_STATUS.FAILED;
      reason: (typeof REQUEST_FAILURE)[keyof typeof REQUEST_FAILURE];
      message: string;
    };

/**
 * 完整模型回复，或明确的停止原因。
 */
export type MessageResult =
  | { status: typeof REQUEST_STATUS.COMPLETED; message: ChatCompletionMessage }
  | StopResult;

/**
 * 流中保留 SDK 原始片段；未完成时产出停止原因。
 */
export type ProviderOutput = ChatCompletionChunk | StopResult;

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
  ): Promise<MessageResult>;
  /**
   * 请求模型，逐段产出 OpenAI 响应片段；未完成时产出停止原因。
   */
  reply(
    history: ChatCompletionMessageParam[],
    context: ModelCallContext,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderOutput>;
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
   * 本轮任务的最终结果，包含状态和回答。
   */
  RESULT: 'result',
  /**
   * 模型流停止的原因。
   */
  STOP: 'stop',
} as const;

/**
 * 流式拼接产出的正文增量和完整助手消息。
 */
export type ModelOutput =
  | { type: typeof OUTPUT_TYPE.TEXT; text: string }
  | { type: typeof OUTPUT_TYPE.MESSAGE; message: ChatCompletionMessage }
  | { type: typeof OUTPUT_TYPE.STOP; result: StopResult };
