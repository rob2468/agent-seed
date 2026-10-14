import { createInterface } from 'node:readline';
import { createHistory, runAgent } from './agent-loop.js';
import { compactHistory } from './compact.js';
import { ContextBudgetError } from './context-budget.js';
import { EXIT_CODE } from './exit-code.js';
import { loadSession, saveSession } from './session.js';
import type { Execute, Provider } from './types.js';

/**
 * 恢复会话，循环处理交互输入、执行任务并保存历史。
 * @param provider 本次会话使用的模型服务。
 * @param execute 工具执行函数。
 * @param maxModelCalls 每轮模型调用次数上限。
 * @returns 会话结束时的退出码。
 */
export async function runSession(
  provider: Provider,
  execute: Execute,
  maxModelCalls: number,
) {
  let history = await loadSession(); // 当前会话历史，启动时从本地文件恢复。
  let exitCode: number = EXIT_CODE.SUCCESS;
  let controller: AbortController | undefined; // 当前任务的取消控制器；任务结束后清空。

  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 任务进行中取消任务，空闲时退出。
  const interrupt = () => {
    if (controller) {
      controller.abort();
      return;
    }

    exitCode = EXIT_CODE.CANCELLED;
    input.close();
  };
  process.on('SIGINT', interrupt);

  // 会话结束时统一移除监听并关闭输入接口。
  try {
    console.log(
      '输入任务开始对话；Ctrl+C 取消当前任务，/compact 压缩上下文，/clear 清空历史，/exit 退出。',
    );
    input.on('SIGINT', interrupt);
    input.setPrompt('你：');
    input.prompt();

    for await (const line of input) {
      const text = line.trim();
      if (text === '/exit') {
        break;
      }

      if (!text) {
        input.prompt();
        continue;
      }

      if (text === '/clear') {
        history = createHistory();
        provider.reset?.();
        await saveSession(history);
        console.log('历史已清空。');
        input.prompt();
        continue;
      }

      const previousHistory = history.slice();
      controller = new AbortController();
      const signal = controller.signal;
      const compacting = text === '/compact';

      // 处理本轮取消和可恢复错误，结束后清空控制器，继续接收输入。
      try {
        if (compacting) {
          const compacted = await compactHistory(history, provider, signal);
          controller = undefined;

          if (compacted === history) {
            console.log('暂无需要压缩的历史。');
          } else {
            await saveSession(compacted);
            history = compacted;
            console.log('上下文已压缩。');
          }
        } else {
          const result = await runAgent(
            text,
            provider,
            execute,
            maxModelCalls,
            history,
            signal,
          );
          controller = undefined;

          await saveSession(history);
          console.log(`\n${result.answer}`);
        } // if compacting
      } catch (error) {
        if (signal.aborted) {
          history = previousHistory;
          provider.reset?.();
          console.log('任务已取消。');
        } else if (compacting && controller) {
          console.error(
            '上下文压缩失败，原历史已保留。可重试或使用 /clear 清空历史。',
          );
        } else if (error instanceof ContextBudgetError) {
          console.error(error.message);
        } else {
          throw error;
        }
      } finally {
        controller = undefined;
      } // try/catch/finally

      input.prompt();
    } // for
  } finally {
    process.off('SIGINT', interrupt);
    input.off('SIGINT', interrupt);
    input.close();
  }

  return exitCode;
}
