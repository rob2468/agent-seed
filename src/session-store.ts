import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { createHistory } from './agent-loop.js';

const sessionFile = resolve('.agent-seed/session.json');

/**
 * 读取当前目录的会话历史；文件不存在时创建新历史。
 * 文件损坏或读取失败时抛出错误，保留原文件。
 */
export async function loadSession(): Promise<ChatCompletionMessageParam[]> {
  let body: string;
  try {
    body = await readFile(sessionFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createHistory();
    }
    throw new Error(
      '读取会话失败，请检查 .agent-seed/session.json 的访问权限。',
    );
  }

  try {
    const history = JSON.parse(body);
    if (
      !Array.isArray(history) ||
      history.length === 0 ||
      history[0]?.role !== 'system' ||
      !history.every(
        (message) =>
          message &&
          ['system', 'user', 'assistant', 'tool'].includes(message.role) &&
          (typeof message.content === 'string' ||
            message.content === null ||
            Array.isArray(message.content)),
      )
    ) {
      throw new Error('无效历史');
    }
    return history;
  } catch {
    throw new Error(
      '会话文件格式无效，请检查 .agent-seed/session.json；原文件已保留。',
    );
  }
}

/**
 * 保存会话历史，先写临时文件再替换原文件。
 * @param history 要保存的完整消息数组。
 */
export async function saveSession(history: ChatCompletionMessageParam[]) {
  try {
    await mkdir(dirname(sessionFile), { recursive: true });
    await writeFile(`${sessionFile}.tmp`, JSON.stringify(history, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(`${sessionFile}.tmp`, sessionFile);
  } catch {
    throw new Error('保存会话失败，请检查 .agent-seed/ 的访问权限和磁盘空间。');
  }
}
