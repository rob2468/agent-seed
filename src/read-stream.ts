import type { ChatCompletionMessage } from 'openai/resources/chat/completions';
import {
  OUTPUT_TYPE,
  REQUEST_STATUS,
  REQUEST_FAILURE,
  type ProviderOutput,
  type ModelOutput,
} from './types.js';

/**
 * 产出正文增量，按索引拼接工具参数，结束后产出完整回复。
 * @param stream SDK 解析后的响应片段。
 * @param signal 当前请求的取消信号。
 */
export async function* readStream(
  stream: AsyncIterable<ProviderOutput>,
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
    if (signal?.aborted) {
      yield {
        type: OUTPUT_TYPE.STOP,
        result: { status: REQUEST_STATUS.CANCELLED },
      };
      return;
    }
    if ('status' in chunk) {
      yield { type: OUTPUT_TYPE.STOP, result: chunk };
      return;
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
      hasText = true;
      yield { type: OUTPUT_TYPE.TEXT, text: delta.content };
    }

    if (delta.refusal) {
      message.refusal = (message.refusal ?? '') + delta.refusal;
    }

    /*
     * delta.tool_calls 是当前响应片段中的工具调用增量数组。
     * index 表示本次模型响应里的第几个工具调用，从 0 开始；
     * 同一 index 的片段合并到 calls[index]，不同调用分别累积。
     * id 是调用 ID，工具结果通过 tool_call_id 与它对应。
     * type 为 function 表示函数工具，function.name 是工具名称。
     * function.arguments 是参数 JSON 的字符串片段，完整拼接后才能解析。
     *
     * 例如，read_file 调用在实际日志中分五次返回：
     * 第一次提供调用 ID、类型和名称，参数为空：
     * {
     *   index: 0,
     *   id: '01a15a17091a70299906f23577260963',
     *   type: 'function',
     *   function: { name: 'read_file', arguments: '' }
     * }
     * 后续四次的 index 都是 0，id 和 type 为 null，name 为空字符串；
     * function.arguments 依次为：
     *   '{'
     *   '"path": "w'
     *   'elcome'
     *   '.md"}'
     * 最终参数为 '{"path": "welcome.md"}'。
     *
     * ID、名称收到非空值时赋值，参数片段持续追加。
     * 这里只组装调用，完整响应交给 Agent Loop 后才执行工具。
     */
    for (const toolCallDelta of delta.tool_calls ?? []) {
      if (
        !Number.isInteger(toolCallDelta.index) ||
        toolCallDelta.index < 0 ||
        toolCallDelta.index >= 8
      ) {
        throw new Error('工具调用索引无效或超过 8 个');
      }

      const call = calls[toolCallDelta.index] ?? {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      };
      if (call.type !== 'function') {
        throw new Error('不支持的工具调用类型');
      }

      if (toolCallDelta.id) {
        call.id = toolCallDelta.id;
      }
      if (toolCallDelta.function?.name) {
        call.function.name = toolCallDelta.function.name;
      }
      call.function.arguments += toolCallDelta.function?.arguments ?? '';
      calls[toolCallDelta.index] = call;
    }
  } // for stream

  if (signal?.aborted) {
    yield {
      type: OUTPUT_TYPE.STOP,
      result: { status: REQUEST_STATUS.CANCELLED },
    };
    return;
  }
  if (!finishReason || !['stop', 'tool_calls'].includes(finishReason)) {
    yield {
      type: OUTPUT_TYPE.STOP,
      result: {
        status: REQUEST_STATUS.FAILED,
        reason: REQUEST_FAILURE.INVALID_RESPONSE,
        message: '模型响应缺失、被截断或被拒绝',
      },
    };
    return;
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
