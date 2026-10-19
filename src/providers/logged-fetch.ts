import { randomUUID } from 'node:crypto';
import { fetch } from 'undici';
import { writeLog } from '../logger.js';
import type { ModelCallContext } from '../types.js';

/**
 * 发送请求并记录原始请求和响应。
 * @param input 请求地址或请求对象。
 * @param init 请求配置。
 * @param tags 本次调用的轮次、模型调用次数和预算计算值。
 * @returns 原始响应。
 */
export async function loggedFetch(
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
