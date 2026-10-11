import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_LOG_FILE = fileURLToPath(
  new URL('../../logs/zenmux.log', import.meta.url),
);

// 仅添加时间、请求 ID 和方向作为分隔，正文原样写入，不解析或改写字段。
export function createFileLogger() {
  return async (
    id: string,
    direction: 'request' | 'response',
    body: string,
  ) => {
    await fs.mkdir(dirname(DEFAULT_LOG_FILE), { recursive: true });
    await fs.appendFile(
      DEFAULT_LOG_FILE,
      `[${new Date().toISOString()}] [${id}] ${direction}\n${body}\n\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  };
}
