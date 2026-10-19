import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { Provider } from '../src/types.js';

// 按固定流程列目录、读文件，再根据工具结果回答。
export function createMockProvider(): Provider {
  return {
    async summarize() {
      return {
        role: 'assistant',
        refusal: null,
        content:
          'Mock 摘要：此前按教学脚本列目录并读取 welcome.md。后续可继续读取文件。此摘要仅演示压缩流程。',
      };
    },
    async *reply(history) {
      const message = mockMessage(history);
      yield {
        id: 'mock',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'mock',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: message.content,
              refusal: message.refusal,
              tool_calls: message.tool_calls
                ?.filter((call) => call.type === 'function')
                .map((call, index) => ({ ...call, index })),
            },
            finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop',
          },
        ],
      };
    },
  };
}

/**
 * 根据本轮工具结果生成教学回复。
 */
function mockMessage(
  history: ChatCompletionMessageParam[],
): ChatCompletionMessage {
  const turn = history.filter((m) => m.role === 'user').length;
  const lastUser = history.map((m) => m.role).lastIndexOf('user');
  const results = history.slice(lastUser + 1).filter((m) => m.role === 'tool');
  if (results.length === 0) {
    return {
      role: 'assistant',
      refusal: null,
      content: '',
      tool_calls: [
        {
          id: `list-${turn}`,
          type: 'function',
          function: { name: 'list_directory', arguments: '{"path":"."}' },
        },
      ],
    };
  }

  if (results.length === 1) {
    return {
      role: 'assistant',
      refusal: null,
      content: '',
      tool_calls: [
        {
          id: `read-${turn}`,
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{"path":"welcome.md"}',
          },
        },
      ],
    };
  }

  const content = results.at(-1)!.content;
  if (typeof content !== 'string') {
    throw new Error('Mock 只支持文本工具结果');
  }
  const result = JSON.parse(content);
  return {
    role: 'assistant',
    refusal: null,
    tool_calls: [],
    content: result.ok
      ? `Mock 已完成列目录 → 读文件 → 回答。\n文件实际内容：\n${result.data.text}`
      : `Mock 收到了工具错误：${result.error}`,
  };
}
