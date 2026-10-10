import type { Model } from './types.js';

// 固定教学脚本，不理解任意任务；后续输出确实依赖工具返回的内容。
export function createMock(): Model {
  return {
    async reply(history) {
      const results = history.filter((m) => m.role === 'tool');
      if (results.length === 0)
        return {
          role: 'assistant',
          content: '',
          calls: [
            { id: 'list-1', name: 'list_directory', arguments: '{"path":"."}' },
          ],
        };
      if (results.length === 1)
        return {
          role: 'assistant',
          content: '',
          calls: [
            {
              id: 'read-1',
              name: 'read_file',
              arguments: '{"path":"welcome.md"}',
            },
          ],
        };
      const result = JSON.parse(results.at(-1)!.content);
      return {
        role: 'assistant',
        calls: [],
        content: result.ok
          ? `Mock 已完成列目录 → 读文件 → 回答。\n文件实际内容：\n${result.data.text}`
          : `Mock 收到了工具错误：${result.error}`,
      };
    },
  };
}
