import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { EnvHttpProxyAgent, fetch } from 'undici';
import {
  CONTEXT_BUDGET_STATUS,
  estimateTokens,
  contextBudgetStatus,
  readContextBudget,
} from '../context-budget.js';
import { loggedFetch } from './logged-fetch.js';
import {
  REQUEST_STATUS,
  REQUEST_FAILURE,
  type StopResult,
  type MessageResult,
  type ProviderOutput,
  type ModelCallContext,
  type Provider,
} from '../types.js';
import { toolDefinitions } from '../tools.js';

/**
 * 请求 ZenMux 模型，管理当前会话的上下文用量基准。
 */
export class ZenMuxProvider implements Provider {
  private readonly apiKey: string;
  private readonly model: string;
  /**
   * 预算提示交给调用方，不直接输出到终端。
   */
  private readonly onWarning?: (message: string) => void;
  private readonly budget = readContextBudget();
  private readonly dispatcher = new EnvHttpProxyAgent();
  /**
   * 上次模型返回的 usage.total_tokens，包含那次请求的输入和回复。
   * 下次请求的输入用量，按这个值加上新增消息的估算 token 数计算。
   * 没拿到有效用量或重置后为 undefined，下次改为估算全部输入。
   */
  private lastTotalTokens: number | undefined;
  /**
   * 记录上次请求的历史条数，再加上那次模型回复这一条。
   * 下次用 history.slice(lastMessageCount) 取出之后新增的消息，只估算这部分。
   * 例如模型一次调用两个工具，随后新增两条工具结果，两条都要计入，不能只算最后一条。
   * 重置时归零，下次重新估算全部输入。
   */
  private lastMessageCount = 0;

  /**
   * @param apiKey 请求认证使用的密钥，不写入日志。
   * @param model 请求使用的 ZenMux 模型标识。
   * @param onWarning 可选的预算提示，由调用方决定如何展示。
   */
  constructor(
    apiKey: string,
    model: string,
    onWarning?: (message: string) => void,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.onWarning = onWarning;
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
  ): AsyncGenerator<ProviderOutput> {
    if (signal?.aborted) {
      yield { status: REQUEST_STATUS.CANCELLED };
      return;
    }
    const prepared = this.prepareRequest(history, context, false);
    if (prepared.status !== REQUEST_STATUS.COMPLETED) {
      yield prepared;
      return;
    }
    const { client, params } = prepared;
    let totalTokens: number | undefined;
    let finishReason: string | null = null;
    try {
      const stream = await client.chat.completions.create(
        { ...params, stream: true, stream_options: { include_usage: true } },
        { signal },
      );
      try {
        for await (const chunk of stream) {
          if (signal?.aborted) {
            yield { status: REQUEST_STATUS.CANCELLED };
            return;
          }
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
      if (signal?.aborted) {
        yield { status: REQUEST_STATUS.CANCELLED };
        return;
      }
      if (!finishReason || !['stop', 'tool_calls'].includes(finishReason)) {
        yield {
          status: REQUEST_STATUS.FAILED,
          reason: REQUEST_FAILURE.INVALID_RESPONSE,
          message: '模型响应缺失、被截断或被拒绝',
        };
        return;
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
      yield requestFailure(error, signal);
    }
  }

  /**
   * 请求完整摘要，不携带工具定义，也不更新会话用量基准。
   */
  async summarize(
    history: ChatCompletionMessageParam[],
    context: ModelCallContext,
    signal?: AbortSignal,
  ): Promise<MessageResult> {
    if (signal?.aborted) {
      return { status: REQUEST_STATUS.CANCELLED };
    }
    const prepared = this.prepareRequest(history, context, true);
    if (prepared.status !== REQUEST_STATUS.COMPLETED) {
      return prepared;
    }
    const { client, params } = prepared;
    try {
      const response = await client.chat.completions.create(params, {
        signal,
      });
      if (signal?.aborted) {
        return { status: REQUEST_STATUS.CANCELLED };
      }
      const choice = response.choices[0];
      if (!choice || choice.finish_reason !== 'stop') {
        return {
          status: REQUEST_STATUS.FAILED,
          reason: REQUEST_FAILURE.INVALID_RESPONSE,
          message: '模型响应缺失、被截断或被拒绝',
        };
      }
      return { status: REQUEST_STATUS.COMPLETED, message: choice.message };
    } catch (error) {
      return requestFailure(error, signal);
    }
  }

  /**
   * 检查上下文预算，准备 SDK 客户端和请求参数。
   * @param history 本次发送给模型的消息。
   * @param context 本次调用的轮次和模型调用次数，用于日志标签。
   * @param summarizing 是否生成摘要；为 true 时不携带工具定义，不更新会话用量基准。
   * @returns 准备成功时的客户端和参数，或本地预算不足的结果。
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
      return {
        status: REQUEST_STATUS.BUDGET_EXCEEDED,
        message: `上下文预算不足：输入测量值 ${inputTokens} tokens，输出预留 ${this.budget.maxOutputTokens}，窗口 ${this.budget.contextWindow}。本次未发送请求。`,
      } as const;
    }
    if (budgetStatus === CONTEXT_BUDGET_STATUS.NEAR_LIMIT) {
      this.onWarning?.(
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
    return { status: REQUEST_STATUS.COMPLETED, client, params } as const;
  }
}

/**
 * 将预期请求异常转换为明确结果；未预期的程序错误继续抛出。
 */
function requestFailure(error: unknown, signal?: AbortSignal): StopResult {
  if (signal?.aborted) {
    return { status: REQUEST_STATUS.CANCELLED };
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return {
      status: REQUEST_STATUS.FAILED,
      reason: REQUEST_FAILURE.TIMEOUT,
      message: 'ZenMux 请求超时（120 秒），请稍后重试。',
    };
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return {
      status: REQUEST_STATUS.FAILED,
      reason: REQUEST_FAILURE.CONNECTION,
      message: 'ZenMux 连接失败，请检查网络或代理配置。',
    };
  }
  if (!(error instanceof OpenAI.APIError)) {
    throw error; // 未预期的程序错误不转换成网络失败。
  }
  if (error.status === 413 || error.code === 'context_length_exceeded') {
    return {
      status: REQUEST_STATUS.FAILED,
      reason: REQUEST_FAILURE.CONTEXT_LIMIT,
      message: '模型服务报告上下文超限，请使用 /clear 清空历史或缩小任务。',
    };
  }

  let status = '';
  if (typeof error.status === 'number') {
    status = `（HTTP ${error.status}）`;
  }
  return {
    status: REQUEST_STATUS.FAILED,
    reason: REQUEST_FAILURE.API,
    message: `ZenMux 接口错误${status}，请检查服务状态或请求配置。`,
  };
}
