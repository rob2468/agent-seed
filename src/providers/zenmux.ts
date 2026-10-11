import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { EnvHttpProxyAgent, fetch } from 'undici';
import { createFileLogger } from '../logger.js';
import type { Provider } from '../types.js';
import { toolDefinitions } from '../tools.js';

// ZenMux 使用 OpenAI 兼容的 Chat Completions 协议。
export const ZENMUX_BASE_URL = 'https://zenmux.ai/api/v1';

export function createZenMuxProvider(apiKey: string, model: string): Provider {
  const log = createFileLogger();
  const loggedFetch: typeof fetch = async (input, init) => {
    const id = randomUUID();
    // SDK 的 JSON 请求正文已经序列化；只记录正文，不记录 URL、认证头或客户端配置。
    if (typeof init?.body !== 'string') {
      throw new Error('ZenMux 日志仅支持 JSON 字符串请求正文');
    }
    await log(id, 'request', init.body);

    const response = await fetch(input, init);
    // 读取副本，保留原响应给 SDK；非成功状态的响应正文也会记录。
    await log(id, 'response', await response.clone().text());
    return response;
  };

  const client = new OpenAI({
    apiKey,
    baseURL: ZENMUX_BASE_URL,
    // 固定使用 undici，按环境变量选择代理或直连。
    fetch: loggedFetch as typeof globalThis.fetch,
    fetchOptions: { dispatcher: new EnvHttpProxyAgent() },
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
