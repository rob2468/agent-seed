import type {
  ChatCompletionMessage,
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
   * 请求回复；onText 接收逐段生成的正文。
   */
  reply(
    history: ChatCompletionMessageParam[],
    context: ModelCallContext,
    signal?: AbortSignal,
    onText?: (text: string) => void,
  ): Promise<ChatCompletionMessage>;
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
  /**
   * 将模型生成的正文显示到终端。
   */
  onText?: (text: string) => void;
}
