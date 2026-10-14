import { AGENT_STATUS, runAgent } from './agent-loop.js';
import { EXIT_CODE } from './exit-code.js';
import { loadSession, saveSession } from './session.js';
import type { Execute, Provider } from './types.js';

/**
 * 恢复历史，执行一次任务并保存结果。
 * @param task 本次用户任务。
 * @param provider 本次使用的模型服务。
 * @param execute 工具执行函数。
 * @param maxModelCalls 模型调用次数上限。
 * @returns 任务结束时的退出码。
 */
export async function runTask(
  task: string,
  provider: Provider,
  execute: Execute,
  maxModelCalls: number,
) {
  const history = await loadSession();

  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);

  try {
    const result = await runAgent(
      task,
      provider,
      execute,
      maxModelCalls,
      history,
      controller.signal,
    );

    await saveSession(history);
    console.log(`\n${result.answer}`);

    if (result.status === AGENT_STATUS.MODEL_CALL_LIMIT) {
      return EXIT_CODE.MODEL_CALL_LIMIT;
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }

    console.log('任务已取消。');
    return EXIT_CODE.CANCELLED;
  } finally {
    process.off('SIGINT', interrupt);
  }

  return EXIT_CODE.SUCCESS;
}
