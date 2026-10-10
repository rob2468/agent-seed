import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { Model } from './types.js';
import { toolDefinitions } from './tools.js';

// SDK 和 wire 格式只留在 provider 边界；核心循环不知道 OpenAI 是什么。
export const ZENMUX_BASE_URL = 'https://zenmux.ai/api/v1';

export function createOpenAI(
  apiKey: string,
  model: string,
  options: { baseURL?: string; fetch?: typeof globalThis.fetch } = {},
): Model {
  const client = new OpenAI({
    apiKey,
    baseURL: options.baseURL ?? 'https://api.openai.com/v1',
    fetch: options.fetch, // 测试注入内存响应，不发网络请求。
    timeout: 30_000,
    maxRetries: 0,
  });

  return {
    async reply(history) {
      const messages: ChatCompletionMessageParam[] = history.map((message) => {
        if (message.role === 'tool') {
          return {
            role: 'tool',
            tool_call_id: message.callId,
            content: message.content,
          };
        }

        if (message.role === 'assistant') {
          return {
            role: 'assistant',
            content: message.content,
            ...(message.calls.length
              ? {
                  tool_calls: message.calls.map((call) => ({
                    id: call.id,
                    type: 'function' as const,
                    function: { name: call.name, arguments: call.arguments },
                  })),
                }
              : {}),
          };
        }

        return message;
      });

      const response = await client.chat.completions.create({
        model,
        messages,
        tools: toolDefinitions,
        max_completion_tokens: 2048,
      });
      const choice = response.choices[0];
      if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason)) {
        throw new Error('模型响应缺失、被截断或被拒绝');
      }

      return {
        role: 'assistant',
        content: choice.message.content ?? '',
        calls: (choice.message.tool_calls ?? []).map((call) => {
          if (call.type !== 'function') {
            throw new Error('不支持的工具调用类型');
          }
          return {
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          };
        }),
      };
    },
  };
}
