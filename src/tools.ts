import { constants } from 'node:fs';
import { open, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Execute } from './types.js';

export const MAX_FILE_BYTES = 16 * 1024;

export const toolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'list_directory',
      description: '列目录，最多 100 项，不递归',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作目录的路径' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: '读取 UTF-8 文本，最多 16 KiB',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作目录的路径' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
];

export async function createTools(directory: string): Promise<Execute> {
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory()) {
    throw new Error('工作目录不是目录');
  }

  const inside = (target: string) => {
    const relative = path.relative(root, target);
    return (
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };

  return async (call) => {
    try {
      if (!['list_directory', 'read_file'].includes(call.function.name)) {
        throw new Error('未知工具');
      }

      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        throw new Error('参数必须是合法 JSON');
      }
      if (
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        Object.keys(args).length !== 1 ||
        !('path' in args) ||
        typeof args.path !== 'string' ||
        !args.path.length ||
        args.path.length > 1024 ||
        args.path.includes('\0')
      ) {
        throw new Error('参数必须且只能包含非空字符串 path（最多 1024 字符）');
      }

      if (
        path.isAbsolute(args.path) ||
        args.path.split(/[\\/]/).includes('..')
      ) {
        throw new Error('不允许绝对路径或 .. 路径穿越');
      }
      const requested = path.resolve(root, args.path);
      if (!inside(requested)) {
        throw new Error('路径超出工作目录');
      }
      const target = await realpath(requested);
      if (!inside(target)) {
        throw new Error('符号链接指向工作目录之外');
      }

      if (call.function.name === 'list_directory') {
        const entries: string[] = [];
        let truncated = false;
        const dir = await opendir(target);
        for await (const entry of dir) {
          if (entries.length === 100) {
            truncated = true;
            break;
          }
          entries.push(
            entry.name +
              (entry.isDirectory() ? '/' : entry.isSymbolicLink() ? '@' : ''),
          );
        }
        return { ok: true, data: { entries: entries.sort(), truncated } };
      }

      // 不跟随最终节点新出现的符号链接；只读普通文件，避免管道等特殊文件。
      const file = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat();
        if (!info.isFile()) {
          throw new Error('只能读取普通文件');
        }
        if (info.size > MAX_FILE_BYTES) {
          throw new Error('文件超过 16 KiB 限制');
        }

        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
        let total = 0;
        while (total < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            total,
            buffer.length - total,
            null,
          );
          if (!bytesRead) {
            break;
          }
          total += bytesRead;
        }
        if (total > MAX_FILE_BYTES) {
          throw new Error('文件超过 16 KiB 限制');
        }

        return {
          ok: true,
          data: {
            text: new TextDecoder('utf-8', { fatal: true }).decode(
              buffer.subarray(0, total),
            ),
          },
        };
      } finally {
        await file.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        ok: false,
        error: code
          ? `文件访问失败（${code}）`
          : error instanceof Error
            ? error.message
            : '工具执行失败',
      };
    }
  };
}
