import OpenAI from 'openai';
import type { Model } from './types.js';
import { toolDefinitions } from './tools.js';

// OpenAI 和 ZenMux 使用相同的 Chat Completions 消息格式。
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
      const response = await client.chat.completions.create({
        model,
        messages: history,
        tools: toolDefinitions,
        max_completion_tokens: 2048,
      });
      const choice = response.choices[0];
      if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason)) {
        throw new Error('模型响应缺失、被截断或被拒绝');
      }

      return choice.message;
    },
  };
}
