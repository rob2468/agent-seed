import type {
  ChatCompletionChunk,
  ChatCompletionMessage,
} from 'openai/resources/chat/completions';
import { OUTPUT_TYPE, type ModelOutput } from './types.js';

/**
 * 产出正文增量，按索引拼接工具参数，结束后产出完整回复。
 * @param stream SDK 解析后的响应片段。
 * @param signal 当前请求的取消信号。
 */
export async function* readStream(
  stream: AsyncIterable<ChatCompletionChunk>,
  signal?: AbortSignal,
): AsyncGenerator<ModelOutput> {
  const message: ChatCompletionMessage = {
    role: 'assistant',
    content: null,
    refusal: null,
  };
  const calls: NonNullable<ChatCompletionMessage['tool_calls']> = [];
  let finishReason: string | null = null;
  let hasText = false;

  for await (const chunk of stream) {
    signal?.throwIfAborted(); // 取消后不再产出或拼接后续片段。

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
      hasText = true;
      yield { type: OUTPUT_TYPE.TEXT, text: delta.content };
    }

    if (delta.refusal) {
      message.refusal = (message.refusal ?? '') + delta.refusal;
    }

    for (const part of delta.tool_calls ?? []) {
      if (!Number.isInteger(part.index) || part.index < 0 || part.index >= 8) {
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

  signal?.throwIfAborted(); // 流结束后已取消，不交出完整回复。
  if (!finishReason || !['stop', 'tool_calls'].includes(finishReason)) {
    throw new Error('模型响应缺失、被截断或被拒绝');
  }

  if (hasText) {
    yield { type: OUTPUT_TYPE.TEXT, text: '\n' };
  }

  for (const call of calls) {
    if (!call || !call.id || call.type !== 'function' || !call.function.name) {
      throw new Error('模型返回了不完整的工具调用');
    }
  }
  if (calls.length > 0) {
    message.tool_calls = calls;
  }

  yield { type: OUTPUT_TYPE.MESSAGE, message };
}
