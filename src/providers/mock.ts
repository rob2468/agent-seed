import type { Provider } from '../types.js';

// 固定教学脚本，不理解任意任务；后续输出确实依赖工具返回的内容。
export function createMockProvider(): Provider {
  return {
    async reply(history) {
      const results = history.filter((m) => m.role === 'tool');
      if (results.length === 0) {
        return {
          role: 'assistant',
          refusal: null,
          content: '',
          tool_calls: [
            {
              id: 'list-1',
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
              id: 'read-1',
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
    },
  };
}
