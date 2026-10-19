import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { EnvHttpProxyAgent, fetch } from 'undici';
import {
  CONTEXT_BUDGET_STATUS,
  ContextBudgetError,
  estimateTokens,
  contextBudgetStatus,
  readContextBudget,
} from '../context-budget.js';
import { loggedFetch } from './logged-fetch.js';
import type { ModelCallContext, Provider } from '../types.js';
import { toolDefinitions } from '../tools.js';

/**
 * 请求 ZenMux 模型，管理当前会话的上下文用量基准。
 */
export class ZenMuxProvider implements Provider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly budget = readContextBudget();
  private readonly dispatcher = new EnvHttpProxyAgent();
  /**
   * 上次调用的输入加输出 token 数，下次加上新增消息的估算量。
   * 未取得有效用量或重置后为 undefined，下次估算完整输入。
   */
  private lastTotalTokens: number | undefined;
  /**
   * 上次用量已覆盖的历史条数，包含助手回复。
   * 用它取出全部新增消息，避免漏算一次多个工具调用产生的结果。
   * 清空或压缩历史后，与用量基准一起重置。
   */
  private lastMessageCount = 0;

  /**
   * @param apiKey 请求认证使用的密钥，不写入日志。
   * @param model 请求使用的 ZenMux 模型标识。
   */
  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  /**
   * 重置上次用量和历史条数，下次请求重新估算完整输入。
   */
  reset() {
    this.lastTotalTokens = undefined;
    this.lastMessageCount = 0;
  }

  /**
   * 携带历史和工具定义请求模型，产出原始片段，流结束后更新用量基准。
   */
  async *reply(
    history: ChatCompletionMessageParam[],
    context: ModelCallContext,
    signal?: AbortSignal,
  ) {
    const { client, params } = this.prepareRequest(history, context, false);
    let totalTokens: number | undefined;
    let finishReason: string | null = null;
    try {
      const stream = await client.chat.completions.create(
        { ...params, stream: true, stream_options: { include_usage: true } },
        { signal },
      );
      try {
        for await (const chunk of stream) {
          signal?.throwIfAborted();
          if (chunk.usage) {
            totalTokens = chunk.usage.total_tokens;
          }
          const choice = chunk.choices.find((item) => item.index === 0);
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }
          yield chunk;
        }
      } finally {
        stream.controller.abort();
      }
      signal?.throwIfAborted();
      if (!finishReason || !['stop', 'tool_calls'].includes(finishReason)) {
        throw new Error('模型响应缺失、被截断或被拒绝');
      }

      if (
        typeof totalTokens === 'number' &&
        Number.isSafeInteger(totalTokens) &&
        totalTokens >= 0
      ) {
        this.lastTotalTokens = totalTokens;
        this.lastMessageCount = history.length + 1; // 用量已包含待加入历史的助手回复。
      } else {
        this.lastTotalTokens = undefined;
        this.lastMessageCount = 0;
      }
    } catch (error) {
      signal?.throwIfAborted(); // 保留取消原因。
      throw requestError(error);
    }
  }

  /**
   * 请求完整摘要，不携带工具定义，也不更新会话用量基准。
   */
  async summarize(
    history: ChatCompletionMessageParam[],
    context: ModelCallContext,
    signal?: AbortSignal,
  ) {
    const { client, params } = this.prepareRequest(history, context, true);
    try {
      const response = await client.chat.completions.create(params, {
        signal,
      });
      const choice = response.choices[0];
      if (!choice || choice.finish_reason !== 'stop') {
        throw new Error('模型响应缺失、被截断或被拒绝');
      }
      return choice.message;
    } catch (error) {
      signal?.throwIfAborted();
      throw requestError(error);
    }
  }

  /**
   * 检查上下文预算，准备 SDK 客户端和请求参数。
   * @param history 本次发送给模型的消息。
   * @param context 本次调用的轮次和模型调用次数，用于日志标签。
   * @param summarizing 是否生成摘要；为 true 时不携带工具定义，不更新会话用量基准。
   * @returns SDK 客户端和请求参数。
   */
  private prepareRequest(
    history: ChatCompletionMessageParam[],
    context: ModelCallContext,
    summarizing: boolean,
  ) {
    let tools: typeof toolDefinitions | undefined = toolDefinitions;
    let baselineTokens = this.lastTotalTokens;
    if (summarizing) {
      tools = undefined;
      baselineTokens = undefined;
    }

    let addedTokens = 0;
    let inputTokens: number;
    if (baselineTokens === undefined) {
      addedTokens = estimateTokens({ messages: history, tools });
      inputTokens = addedTokens;
    } else {
      const addedMessages = history.slice(this.lastMessageCount);
      if (addedMessages.length > 0) {
        addedTokens = estimateTokens(addedMessages);
      }
      inputTokens = baselineTokens + addedTokens;
    }

    const budgetStatus = contextBudgetStatus(inputTokens, this.budget);
    if (budgetStatus === CONTEXT_BUDGET_STATUS.EXHAUSTED) {
      throw new ContextBudgetError(
        `上下文预算不足：输入测量值 ${inputTokens} tokens，输出预留 ${this.budget.maxOutputTokens}，窗口 ${this.budget.contextWindow}。本次未发送请求，请使用 /clear 清空历史或缩小任务。`,
      );
    }
    if (budgetStatus === CONTEXT_BUDGET_STATUS.NEAR_LIMIT) {
      console.warn(
        `上下文预算提示：输入测量值 ${inputTokens} tokens，输出预留 ${this.budget.maxOutputTokens}，已接近窗口 ${this.budget.contextWindow}。新增内容为估算，实际长度以服务端为准。`,
      );
    }

    const tags = {
      ...context,
      lastTotalTokens: baselineTokens ?? 'unknown',
      addedTokens,
    };

    const client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: 'https://zenmux.ai/api/v1',
      // 使用 undici，按环境变量选择代理或直连。
      fetch: ((
        input: Parameters<typeof fetch>[0],
        init: Parameters<typeof fetch>[1],
      ) => loggedFetch(input, init, tags)) as typeof globalThis.fetch,
      fetchOptions: { dispatcher: this.dispatcher },
      timeout: 120_000,
      maxRetries: 0,
    });
    const params = {
      model: this.model,
      messages: history,
      tools,
      max_completion_tokens: this.budget.maxOutputTokens,
    };
    return { client, params };
  }
}

/**
 * 将请求异常转换为不含认证信息的错误提示。
 */
function requestError(error: unknown) {
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new Error('ZenMux 请求超时（120 秒），请稍后重试。');
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new Error('ZenMux 连接失败，请检查网络或代理配置。');
  }
  if (!(error instanceof OpenAI.APIError)) {
    return error;
  }
  if (error.status === 413 || error.code === 'context_length_exceeded') {
    return new ContextBudgetError(
      '模型服务报告上下文超限，请使用 /clear 清空历史或缩小任务。',
    );
  }

  let status = '';
  if (typeof error.status === 'number') {
    status = `（HTTP ${error.status}）`;
  }
  return new Error(`ZenMux 接口错误${status}，请检查服务状态或请求配置。`);
}
