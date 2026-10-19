import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessage,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions';
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

/**
 * 发送请求并记录原始请求和响应。
 * @param input 请求地址或请求对象。
 * @param init 请求配置。
 * @param tags 本次调用的轮次、模型调用次数和预算计算值。
 * @returns 原始响应。
 */
async function loggedFetch(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  tags: ModelCallContext & {
    lastTotalTokens: number | string;
    addedTokens: number;
  },
) {
  const id = randomUUID();
  // 记录 SDK 已序列化的请求正文。
  if (typeof init?.body !== 'string') {
    throw new Error('ZenMux 日志仅支持 JSON 字符串请求正文');
  }
  await writeLog(init.body, {
    requestId: id,
    direction: 'request',
    ...tags,
  });

  const response = await fetch(input, init);
  if (
    !response.body ||
    !response.headers.get('content-type')?.includes('text/event-stream')
  ) {
    const body = await response.clone().text();
    await logResponse(body, id, tags);
    return response;
  }

  // 一边交给 SDK，一边保留原始 SSE 正文，不能先等完整响应。
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let logged = false;
  async function finish() {
    if (logged) {
      return;
    }
    logged = true;
    body += decoder.decode();
    await logResponse(body, id, tags);
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await finish();
          controller.close();
          return;
        }
        body += decoder.decode(value, { stream: true });
        controller.enqueue(value);
      } catch (error) {
        await finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await finish();
      }
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * 原样保存 JSON 或 SSE 响应，只从正文提取用量标签。
 */
async function logResponse(body: string, id: string, tags: ModelCallContext) {
  let totalTokens: number | string = 'unknown';
  let values = [body];
  if (body.startsWith('data:') || body.includes('\ndata:')) {
    values = body
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5));
  }
  for (const value of values) {
    try {
      const tokens = JSON.parse(value)?.usage?.total_tokens;
      if (
        typeof tokens === 'number' &&
        Number.isSafeInteger(tokens) &&
        tokens >= 0
      ) {
        totalTokens = tokens;
      }
    } catch {
      // SSE 结束标记或不完整片段仍原样保留。
    }
  }
  await writeLog(body, {
    requestId: id,
    direction: 'response',
    turn: tags.turn,
    modelCall: tags.modelCall,
    totalTokens,
  });
}

/**
 * 显示文本增量，按索引拼接工具参数，结束后返回完整回复和用量。
 * @param stream SDK 解析后的响应片段。
 * @param onText 显示正文的函数。
 * @param signal 当前请求的取消信号。
 */
async function readStream(
  stream: AsyncIterable<ChatCompletionChunk>,
  onText: (text: string) => void,
  signal?: AbortSignal,
) {
  const message: ChatCompletionMessage = {
    role: 'assistant',
    content: null,
    refusal: null,
  };
  const calls: NonNullable<ChatCompletionMessage['tool_calls']> = [];
  let finishReason: string | null = null;
  let usage: NonNullable<ChatCompletionChunk['usage']> | undefined;
  let displayed = false;
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted(); // 取消后不再显示或拼接后续片段。
      if (chunk.usage) {
        usage = chunk.usage;
      }
      const choice = chunk.choices.find((item) => item.index === 0);
      if (!choice) {
        continue;
      }
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = choice.delta;
      if (delta.content) {
        message.content = (message.content ?? '') + delta.content;
        displayed = true;
        onText(delta.content);
      }
      if (delta.refusal) {
        message.refusal = (message.refusal ?? '') + delta.refusal;
      }

      for (const part of delta.tool_calls ?? []) {
        if (
          !Number.isInteger(part.index) ||
          part.index < 0 ||
          part.index >= 8
        ) {
          throw new Error('工具调用索引无效或超过 8 个');
        }
        const call = calls[part.index] ?? {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (call.type !== 'function') {
          throw new Error('不支持的工具调用类型');
        }
        call.id += part.id ?? '';
        call.function.name += part.function?.name ?? '';
        call.function.arguments += part.function?.arguments ?? '';
        calls[part.index] = call;
      }
    } // for stream
  } finally {
    if (displayed) {
      onText('\n');
    }
  }

  for (const call of calls) {
    if (!call || !call.id || call.type !== 'function' || !call.function.name) {
      throw new Error('模型返回了不完整的工具调用');
    }
  }
  if (calls.length > 0) {
    message.tool_calls = calls;
  }
  return { choices: [{ message, finish_reason: finishReason ?? '' }], usage };
}

/**
 * 创建 ZenMux Provider，发送模型请求、记录日志并检查上下文预算。
 * 每个实例保存一个会话的用量基准，预算与代理配置从环境变量读取。
 * @param apiKey ZenMux API 密钥，用于请求认证，不写入日志。
 * @param model ZenMux 模型标识，作为请求的 model 字段发送给服务端。
 * @returns 提供对话回复、上下文摘要和用量基准重置能力的 Provider。
 */
export function createZenMuxProvider(apiKey: string, model: string): Provider {
  const budget = readContextBudget();
  // 上次服务端返回的 total_tokens，包含该次输入和助手回答。
  // 下次在此基础上加新增消息的估算量。
  // 没有有效用量或重置后为 undefined，下次估算完整输入。
  let lastTotalTokens: number | undefined;
  // 上次用量基准已覆盖的历史消息条数，包含上次助手回答。
  // 用于取出全部新增消息，避免重复估算上次回答。
  // 一次调用多个工具时，会新增多条工具结果；只取最后一条会漏算其他工具结果。
  // 清空或压缩历史后，与用量基准一起重置。
  let lastMessageCount = 0;
  const dispatcher = new EnvHttpProxyAgent();

  return {
    /**
     * 重置上次用量和历史条数，下次请求重新估算完整输入。
     */
    reset() {
      lastTotalTokens = undefined;
      lastMessageCount = 0;
    },
    /**
     * 携带历史消息和工具定义请求模型，返回回复并更新上下文用量基准。
     */
    reply: (history, context, signal, onText) =>
      request(history, context, false, signal, onText),
    /**
     * 请求模型生成摘要，不携带工具定义，也不更新会话用量基准。
     */
    summarize: (history, context, signal) =>
      request(history, context, true, signal),
  };

  /**
   * 检查上下文预算，发送模型请求并记录原始出入参。
   * @param history 本次发送给模型的消息。
   * @param context 本次调用的轮次和模型调用次数，用于日志标签。
   * @param summarizing 是否生成摘要；为 true 时不携带工具定义，不更新会话用量基准。
   * @param signal 取消当前模型请求的信号。
   * @param onText 接收流式正文；未提供时返回完整响应。
   * @returns 模型返回的助手消息。
   */
  async function request(
    history: ChatCompletionMessageParam[],
    context: ModelCallContext,
    summarizing: boolean,
    signal?: AbortSignal,
    onText?: (text: string) => void,
  ) {
    let tools: typeof toolDefinitions | undefined = toolDefinitions;
    let baselineTokens = lastTotalTokens;
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
      const addedMessages = history.slice(lastMessageCount);
      if (addedMessages.length > 0) {
        addedTokens = estimateTokens(addedMessages);
      }
      inputTokens = baselineTokens + addedTokens;
    }

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

    const tags = {
      ...context,
      lastTotalTokens: baselineTokens ?? 'unknown',
      addedTokens,
    };

    const client = new OpenAI({
      apiKey,
      baseURL: 'https://zenmux.ai/api/v1',
      // 使用 undici，按环境变量选择代理或直连。
      fetch: ((
        input: Parameters<typeof fetch>[0],
        init: Parameters<typeof fetch>[1],
      ) => loggedFetch(input, init, tags)) as typeof globalThis.fetch,
      fetchOptions: { dispatcher },
      timeout: 120_000,
      maxRetries: 0,
    });
    let response;
    try {
      const params = {
        model,
        messages: history,
        tools,
        max_completion_tokens: budget.maxOutputTokens,
      };
      if (onText) {
        const stream = await client.chat.completions.create(
          { ...params, stream: true, stream_options: { include_usage: true } },
          { signal },
        );
        try {
          response = await readStream(stream, onText, signal);
        } finally {
          stream.controller.abort();
        }
      } else {
        response = await client.chat.completions.create(params, { signal });
      }
    } catch (error) {
      signal?.throwIfAborted(); // 保留取消原因，避免被转换成连接错误。

      // 超时属于连接错误，连接错误又属于 APIError，按具体到一般判断。
      // 返回固定提示和 HTTP 状态码，避免泄露请求凭据。
      if (error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new Error('ZenMux 请求超时（120 秒），请稍后重试。');
      }
      if (error instanceof OpenAI.APIConnectionError) {
        throw new Error('ZenMux 连接失败，请检查网络或代理配置。');
      }
      if (!(error instanceof OpenAI.APIError)) {
        throw error;
      }
      if (error.status === 413 || error.code === 'context_length_exceeded') {
        throw new ContextBudgetError(
          '模型服务报告上下文超限，请使用 /clear 清空历史或缩小任务。',
        );
      }

      let status = '';
      if (typeof error.status === 'number') {
        status = `（HTTP ${error.status}）`;
      }
      throw new Error(`ZenMux 接口错误${status}，请检查服务状态或请求配置。`);
    } // try/catch
    const choice = response.choices[0];
    if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason)) {
      throw new Error('模型响应缺失、被截断或被拒绝');
    }

    // 摘要请求直接返回，不更新会话用量基准。
    if (summarizing) {
      return choice.message;
    }

    const totalTokens = response.usage?.total_tokens;
    if (
      typeof totalTokens === 'number' &&
      Number.isSafeInteger(totalTokens) &&
      totalTokens >= 0
    ) {
      lastTotalTokens = totalTokens;
      // 本次回答已包含在 total_tokens 中，预先计入它对应的一条历史消息。
      lastMessageCount = history.length + 1;
    } else {
      lastTotalTokens = undefined;
      lastMessageCount = 0;
    }
    return choice.message;
  } // request
}
