import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { SessionStore, StoredSession } from './types.js';

const sessionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 本地 JSON 会话存储；路径和警告处理由调用方指定。
 */
export class FileSessionStore implements SessionStore {
  /**
   * 保存会话文件的目录。
   */
  private readonly directory: string;
  /**
   * 扫描时跳过损坏文件的通知，不直接打印。
   */
  private readonly onWarning?: (message: string) => void;

  constructor(directory: string, onWarning?: (message: string) => void) {
    this.directory = directory;
    this.onWarning = onWarning;
  }

  /**
   * 校验 ID 并定位会话，不接受任意文件路径。
   */
  private sessionPath(id: string) {
    if (!sessionIdPattern.test(id)) {
      throw new Error('会话 ID 必须是小写 UUID，不能是文件路径。');
    }
    return join(this.directory, `${id}.json`);
  }

  /**
   * 恢复指定会话；读取失败或格式无效时保留原文件并报错。
   */
  async load(id: string): Promise<StoredSession> {
    const file = this.sessionPath(id);
    let body;
    try {
      body = await readFile(file, 'utf8');
    } catch {
      throw new Error(`无法读取会话 ${id}，请检查文件是否存在及访问权限。`);
    }
    try {
      const session = JSON.parse(body);
      const history = session?.history;
      if (
        typeof session?.root !== 'string' ||
        !isAbsolute(session.root) ||
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
      return session;
    } catch {
      throw new Error(`会话文件格式无效：${id}；原文件已保留。`);
    }
  }

  /**
   * 扫描当前工作目录最近保存的会话；相同时间取 ID 字典序较大者。
   * 损坏或不可读取的候选文件提示后跳过，不建立索引。
   */
  async latest(root: string): Promise<string> {
    let names: string[] = [];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('无法读取会话目录，请检查访问权限。');
      }
    }
    let latest: { id: string; time: number } | undefined;
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const id = name.slice(0, -5);
      if (!sessionIdPattern.test(id)) {
        continue;
      }
      try {
        const session = await this.load(id);
        if (session.root !== root) {
          continue;
        }
        const { mtimeMs: time } = await stat(this.sessionPath(id));
        if (
          !latest ||
          time > latest.time ||
          (time === latest.time && id > latest.id)
        ) {
          latest = { id, time };
        }
      } catch (error) {
        this.onWarning?.(`跳过会话 ${id}：${(error as Error).message}`);
      }
    }
    if (!latest) {
      throw new Error('当前工作目录没有可恢复的会话。');
    }
    return latest.id;
  }

  /**
   * 保存当前会话，先写临时文件再替换原文件。
   */
  async save(id: string, session: StoredSession) {
    const file = this.sessionPath(id);
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(session, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(`${file}.tmp`, file);
    } catch {
      throw new Error('保存会话失败，请检查会话目录的访问权限和磁盘空间。');
    }
  }
}
