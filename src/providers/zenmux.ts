import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { randomUUID } from 'node:crypto';
import { EnvHttpProxyAgent, fetch } from 'undici';
import {
  CONTEXT_BUDGET_STATUS,
  ContextBudgetError,
  estimateTokens,
  contextBudgetStatus,
  readContextBudget,
} from '../context-budget.js';
import { writeLog } from '../logger.js';
import type { ModelCallContext, Provider } from '../types.js';
import { toolDefinitions } from '../tools.js';

// ZenMux 使用 OpenAI 兼容的 Chat Completions 协议。
export const ZENMUX_BASE_URL = 'https://zenmux.ai/api/v1';

export function createZenMuxProvider(apiKey: string, model: string): Provider {
  const budget = readContextBudget();
  /**
   * 上次服务端返回的 total_tokens，包含该次输入和助手回答。
   * 作为下一次上下文估算的基准，只需再加上新增消息的估算量。
   * 首次调用、缺失有效 usage 或清空历史后为 undefined，改为估算完整输入。
   */
  let lastTotalTokens: number | undefined;
  /**
   * 上次用量基准已覆盖的历史消息条数，包含上次助手回答。
   * 用 history.slice(lastMessageCount) 取出全部新增消息，避免重复估算已覆盖的内容。
   * 一次调用多个工具时，会新增多条工具结果；只取最后一条会漏算其他工具结果。
   * 历史只追加，清空时与用量基准一起重置。
   */
  let lastMessageCount = 0;
  const dispatcher = new EnvHttpProxyAgent();

  return {
    reset() {
      lastTotalTokens = undefined;
      lastMessageCount = 0;
    },

    async reply(
      history: ChatCompletionMessageParam[],
      context: ModelCallContext,
    ) {
      const addedMessages = history.slice(lastMessageCount);
      const addedTokens =
        addedMessages.length > 0 ? estimateTokens(addedMessages) : 0;
      const inputTokens =
        lastTotalTokens === undefined
          ? estimateTokens({ messages: history, tools: toolDefinitions })
          : lastTotalTokens + addedTokens;
      const budgetStatus = contextBudgetStatus(inputTokens, budget);
      if (budgetStatus === CONTEXT_BUDGET_STATUS.EXHAUSTED) {
        throw new ContextBudgetError(
          `上下文预算不足：输入测量值 ${inputTokens} tokens，输出预留 ${budget.maxOutputTokens}，窗口 ${budget.contextWindow}。本次未发送请求，请使用 /clear 清空历史或缩小任务。`,
        );
      }
      if (budgetStatus === CONTEXT_BUDGET_STATUS.NEAR_LIMIT) {
        console.warn(
          `上下文预算提示：输入测量值 ${inputTokens} tokens，输出预留 ${budget.maxOutputTokens}，已接近窗口 ${budget.contextWindow}。新增内容为估算，实际长度以服务端为准。`,
        );
      }

      const budgetTags = {
        lastTotalTokens: lastTotalTokens ?? 'unknown',
        addedTokens: lastTotalTokens === undefined ? inputTokens : addedTokens,
      };
      const loggedFetch: typeof fetch = async (input, init) => {
        const id = randomUUID();
        // SDK 的 JSON 请求正文已经序列化；只记录正文，不记录 URL、认证头或客户端配置。
        if (typeof init?.body !== 'string') {
          throw new Error('ZenMux 日志仅支持 JSON 字符串请求正文');
        }
        await writeLog(init.body, {
          requestId: id,
          direction: 'request',
          ...context,
          ...budgetTags,
        });

        const response = await fetch(input, init);
        // 读取副本，保留原响应给 SDK；非成功状态的响应正文也会记录。
        const body = await response.clone().text();

        // 仅提取数字用于标签；日志主体仍写入未经改写的响应正文。
        let totalTokens: unknown;
        try {
          totalTokens = JSON.parse(body)?.usage?.total_tokens;
        } catch {
          // 非 JSON 错误正文也原样记录，交给 SDK 处理。
        }
        await writeLog(body, {
          requestId: id,
          direction: 'response',
          ...context,
          totalTokens:
            typeof totalTokens === 'number' &&
            Number.isSafeInteger(totalTokens) &&
            totalTokens >= 0
              ? totalTokens
              : 'unknown',
        });
        return response;
      };

      const client = new OpenAI({
        apiKey,
        baseURL: ZENMUX_BASE_URL,
        // 固定使用 undici，按环境变量选择代理或直连。
        fetch: loggedFetch as typeof globalThis.fetch,
        fetchOptions: { dispatcher },
        timeout: 120_000,
        maxRetries: 0,
      });
      try {
        const response = await client.chat.completions.create({
          model,
          messages: history,
          tools: toolDefinitions,
          max_completion_tokens: budget.maxOutputTokens,
        });

        const choice = response.choices[0];
        if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason)) {
          throw new Error('模型响应缺失、被截断或被拒绝');
        }

        const totalTokens = response.usage?.total_tokens;
        if (
          typeof totalTokens === 'number' &&
          Number.isSafeInteger(totalTokens) &&
          totalTokens >= 0
        ) {
          lastTotalTokens = totalTokens;
          // Agent Loop 返回后会追加本次 assistant 回答，它已包含在 total_tokens 中。
          lastMessageCount = history.length + 1;
        } else {
          lastTotalTokens = undefined;
          lastMessageCount = 0;
        }
        return choice.message;
      } catch (error) {
        // 超时属于连接错误，连接错误又属于 APIError，按具体到一般判断。
        // 只生成固定提示及 HTTP 状态码，不输出 SDK 原始消息、认证头或 cause。
        if (error instanceof OpenAI.APIConnectionTimeoutError) {
          throw new Error('ZenMux 请求超时（120 秒），请稍后重试。');
        }
        if (error instanceof OpenAI.APIConnectionError) {
          throw new Error('ZenMux 连接失败，请检查网络或代理配置。');
        }
        if (error instanceof OpenAI.APIError) {
          if (
            error.status === 413 ||
            error.code === 'context_length_exceeded'
          ) {
            throw new ContextBudgetError(
              '模型服务报告上下文超限，请使用 /clear 清空历史或缩小任务。',
            );
          }

          const status =
            typeof error.status === 'number' ? `（HTTP ${error.status}）` : '';
          throw new Error(
            `ZenMux 接口错误${status}，请检查服务状态或请求配置。`,
          );
        }
        throw error;
      }
    },
  };
}
