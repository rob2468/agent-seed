import { constants } from 'node:fs';
import { open, opendir, realpath, stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { Execute, ConfirmWrite } from './types.js';

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
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: '经用户确认后写入 UTF-8 文本，最多 16 KiB，父目录必须存在',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作目录的路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
];

/**
 * 创建工具执行器，保存工作目录和写入确认函数。
 * @param directory 工具可访问的根目录。
 * @param confirm 写入前的确认函数；未提供时拒绝写入。
 */
export async function createTools(
  directory: string,
  confirm?: ConfirmWrite,
): Promise<Execute> {
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

  return async (call, signal) => {
    try {
      if (
        !['list_directory', 'read_file', 'write_file'].includes(
          call.function.name,
        )
      ) {
        throw new Error('未知工具');
      }

      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        throw new Error('参数必须是合法 JSON');
      }
      const writing = call.function.name === 'write_file';
      if (
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        Object.keys(args).length !== (writing ? 2 : 1) ||
        !('path' in args) ||
        typeof args.path !== 'string' ||
        !args.path.length ||
        args.path.length > 1024 ||
        args.path.includes('\0')
      ) {
        throw new Error(
          '参数必须包含非空字符串 path（最多 1024 字符）；写入时还需 content，不能包含其他字段',
        );
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
      if (writing) {
        if (
          !('content' in args) ||
          typeof args.content !== 'string' ||
          args.content.includes('\0')
        ) {
          throw new Error('content 必须是文本字符串，不能包含空字符');
        }
        if (Buffer.byteLength(args.content, 'utf8') > MAX_FILE_BYTES) {
          throw new Error('文件超过 16 KiB 限制');
        }
        return await writeTextFile(
          root,
          requested,
          args.content,
          confirm,
          signal,
        );
      }

      const target = await realpath(requested);
      if (!inside(target)) {
        throw new Error('符号链接指向工作目录之外');
      }

      if (call.function.name === 'list_directory') {
        return await listDirectory(target);
      }
      return await readTextFile(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      let message = '工具执行失败';
      if (code) {
        message = `文件访问失败（${code}）`;
      } else if (error instanceof Error) {
        message = error.message;
      }
      return { ok: false, error: message };
    } // try/catch
  };
}

/**
 * 列出目录中的前 100 项，并标记目录和符号链接。
 * @param target 目录的绝对路径。
 */
async function listDirectory(target: string) {
  const entries: string[] = [];
  let truncated = false;
  const dir = await opendir(target);
  for await (const entry of dir) {
    if (entries.length === 100) {
      truncated = true;
      break;
    }

    let name = entry.name;
    if (entry.isDirectory()) {
      name += '/';
    } else if (entry.isSymbolicLink()) {
      name += '@';
    }
    entries.push(name);
  } // for

  return { ok: true as const, data: { entries: entries.sort(), truncated } };
}

/**
 * 读取最多 16 KiB 的 UTF-8 普通文件。
 * @param target 文件的绝对路径。
 */
async function readTextFile(target: string) {
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
    } // while
    if (total > MAX_FILE_BYTES) {
      throw new Error('文件超过 16 KiB 限制');
    }

    return {
      ok: true as const,
      data: {
        text: new TextDecoder('utf-8', { fatal: true }).decode(
          buffer.subarray(0, total),
        ),
      },
    };
  } finally {
    await file.close();
  } // try/finally
}

/**
 * 确认后创建或覆盖文本文件，不创建目录，不写符号链接或硬链接。
 * @param root 工作目录。
 * @param target 文件的绝对路径。
 * @param content 完整文本内容。
 * @param confirm 用户确认函数，未提供时拒绝写入。
 * @param signal 写入前检查的取消信号。
 */
async function writeTextFile(
  root: string,
  target: string,
  content: string,
  confirm?: ConfirmWrite,
  signal?: AbortSignal,
) {
  const parent = path.dirname(target);
  if ((await realpath(parent)) !== parent) {
    throw new Error('写入目录必须位于工作目录内，不能经过符号链接');
  }

  let existing;
  try {
    existing = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  if (existing && (!existing.isFile() || existing.nlink !== 1)) {
    throw new Error('只能覆盖普通文本文件，不能写符号链接或硬链接');
  }

  // 保留文件句柄，确认前只读，确认后才修改。
  let file;
  if (existing) {
    file = await open(
      target,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  }
  try {
    if (file) {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.ino !== existing!.ino ||
        info.dev !== existing!.dev ||
        info.size > MAX_FILE_BYTES
      ) {
        throw new Error('目标已变化或超过 16 KiB 限制');
      }
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(0, bytesRead),
      );
      if (bytesRead > MAX_FILE_BYTES || text.includes('\0')) {
        throw new Error('只能覆盖 16 KiB 内的 UTF-8 文本文件');
      }
    }

    signal?.throwIfAborted(); // 已取消时不请求写入确认。
    if (
      !confirm ||
      !(await confirm(
        path.relative(root, target),
        content,
        Boolean(existing),
        signal,
      ))
    ) {
      return { ok: false as const, error: '用户拒绝写入，文件未修改' };
    }
    signal?.throwIfAborted(); // 确认期间取消，不执行写入。

    if ((await realpath(parent)) !== parent) {
      throw new Error('写入目录已变化，请重新请求确认');
    }
    if (file) {
      const current = await lstat(target);
      if (
        !current.isFile() ||
        current.nlink !== 1 ||
        current.ino !== existing!.ino ||
        current.dev !== existing!.dev ||
        current.size !== existing!.size ||
        current.mtimeMs !== existing!.mtimeMs
      ) {
        throw new Error('文件已变化，请重新请求确认');
      }
      signal?.throwIfAborted(); // 文件检查期间取消，不覆盖内容。
    } else {
      signal?.throwIfAborted(); // 路径检查期间取消，不创建文件。
      file = await open(
        target,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    }
    await file.writeFile(content, 'utf8');
    await file.truncate(Buffer.byteLength(content, 'utf8'));
    return {
      ok: true as const,
      data: { path: path.relative(root, target), written: true },
    };
  } finally {
    await file?.close();
  } // try/finally
}
