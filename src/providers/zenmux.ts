import OpenAI from 'openai';
import { EnvHttpProxyAgent, fetch } from 'undici';
import type { Provider } from '../types.js';
import { toolDefinitions } from '../tools.js';

// ZenMux 使用 OpenAI 兼容的 Chat Completions 协议。
export const ZENMUX_BASE_URL = 'https://zenmux.ai/api/v1';

export function createZenMuxProvider(
  apiKey: string,
  model: string,
  options: { fetch?: typeof globalThis.fetch } = {},
): Provider {
  const client = new OpenAI({
    apiKey,
    baseURL: ZENMUX_BASE_URL,
    // 测试使用注入的 fetch；真实请求按环境变量选择代理或直连。
    fetch: options.fetch ?? (fetch as typeof globalThis.fetch),
    fetchOptions: options.fetch
      ? undefined
      : { dispatcher: new EnvHttpProxyAgent() },
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
