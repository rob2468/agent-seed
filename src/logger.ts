import type { ModelCallContext } from './types.js';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_LOG_FILE = fileURLToPath(
  new URL('../../logs/zenmux.log', import.meta.url),
);

function localTimestamp() {
  const now = new Date();
  // 使用这次记录发生时的本机偏移，也适用于夏令时。
  const offset = -now.getTimezoneOffset();
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  const local = new Date(now.getTime() + offset * 60_000)
    .toISOString()
    .slice(0, -1)
    .replace('T', ' ');
  return `${local}${offset >= 0 ? '+' : '-'}${hours}:${minutes}`;
}

/**
 * 日志标签；调用信息与用量只写入标签区，不混入原始正文。
 */
interface LogTags extends ModelCallContext {
  requestId: string;
  direction: 'request' | 'response';
  [key: string]: number | string;
}

// 文件路径和时间由日志模块管理；正文原样写入，不解析或改写字段。
export async function writeLog(body: string, tags: LogTags) {
  const { requestId, direction, turn, modelCall, ...extra } = tags;
  const extraTags = Object.entries(extra)
    .map(([key, value]) => ` [${key}=${value}]`)
    .join('');

  await fs.mkdir(dirname(DEFAULT_LOG_FILE), { recursive: true });
  await fs.appendFile(
    DEFAULT_LOG_FILE,
    `[${localTimestamp()}] [${requestId}] [turn=${turn}] [modelCall=${modelCall}]${extraTags} ${direction}\n${body}\n\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}
