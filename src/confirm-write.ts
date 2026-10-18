import type { Interface } from 'node:readline';

/**
 * 展示写入信息，只接受 y 或 yes 作为确认。
 * @param input 终端输入接口。
 * @param lines 与会话共用的输入迭代器，确认答案不会作为新任务执行。
 * @param path 待写入的相对路径。
 * @param content 完整文本内容。
 * @param overwrite 是否覆盖已有文件。
 * @param signal 取消等待确认的信号。
 */
export async function confirmWrite(
  input: Interface,
  lines: AsyncIterator<string>,
  path: string,
  content: string,
  overwrite: boolean,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  console.log(
    `\n写入路径：${path}\n覆盖已有文件：${overwrite ? '是' : '否'}\n内容：`,
  );
  console.log(content);
  console.log('—— 内容结束 ——');
  process.stdout.write('允许写入？[y/N]：');

  // 唤醒正在等待输入的迭代器，随后用取消信号停止操作。
  const cancel = () => input.emit('line', '');
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const answer = await lines.next();
    signal?.throwIfAborted();
    if (answer.done) {
      return false;
    }
    return ['y', 'yes'].includes(answer.value.trim().toLowerCase());
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
