import { loadSession, saveSession } from './session.js';
import { compactHistory } from './compact.js';
import { ContextBudgetError } from './context-budget.js';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AGENT_STATUS, createHistory, runAgent } from './agent-loop.js';
import { createMockProvider } from './providers/mock.js';
import { createTools } from './tools.js';

const EXIT_CODE = {
  // 参数、文件访问或模型连接等执行异常。
  ERROR: 1,
  // 达到模型请求次数上限，尚未获得最终回答。
  MODEL_CALL_LIMIT: 2,
} as const;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      // 运行模式：命令行参数优先，其次 AGENT_MODE，默认 mock。
      mode: { type: 'string', default: process.env.AGENT_MODE || 'mock' },
      // 工具可访问的根目录，默认项目的 demo/。
      root: { type: 'string' },
      // 每轮最多调用模型的次数，默认 6，取值 1–20。
      'max-model-calls': { type: 'string', default: '6' },
      // 显示命令用法。
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      '用法：npm start -- [--mode mock|zenmux] [--root 目录] [--max-model-calls 1..20] ["任务"]\n不带任务进入多轮会话：/compact 压缩上下文，/clear 清空历史，/exit 退出。\n模式优先级：--mode > AGENT_MODE > mock',
    );
  } else {
    if (!['mock', 'zenmux'].includes(values.mode!)) {
      throw new Error('mode 只能是 mock 或 zenmux');
    }

    const task = positionals.join(' ');
    const maxModelCalls = Number(values['max-model-calls']);
    if (
      !Number.isInteger(maxModelCalls) ||
      maxModelCalls < 1 ||
      maxModelCalls > 20
    ) {
      throw new Error('maxModelCalls 必须是 1–20 的整数');
    }

    const root =
      values.root ?? fileURLToPath(new URL('../../demo/', import.meta.url));
    const execute = await createTools(root);

    let provider = createMockProvider();
    if (values.mode === 'zenmux') {
      // 读取 ZenMux 密钥和模型配置。
      const key = process.env.ZENMUX_API_KEY;
      const name = process.env.ZENMUX_MODEL;
      if (!key || !name) {
        throw new Error('ZenMux 模式需要设置 ZENMUX_API_KEY 和 ZENMUX_MODEL');
      }

      const { createZenMuxProvider } = await import('./providers/zenmux.js');
      provider = createZenMuxProvider(key, name);
    }

    console.log(`agent-seed | ${values.mode} | 工作目录：${root}`);
    let history = await loadSession();
    const runTurn = async (input: string) => {
      const result = await runAgent(
        input,
        provider,
        execute,
        maxModelCalls,
        history,
      );
      await saveSession(history);
      console.log(`\n${result.answer}`);
      return result;
    };

    if (task) {
      const result = await runTurn(task);
      if (result.status === AGENT_STATUS.MODEL_CALL_LIMIT) {
        process.exitCode = EXIT_CODE.MODEL_CALL_LIMIT;
      }
    } else {
      console.log(
        '输入任务开始对话；/compact 压缩上下文，/clear 清空历史，/exit 退出。',
      );
      const input = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      input.setPrompt('你：');
      input.prompt();
      try {
        // 当前轮次完成后再处理下一条输入。
        for await (const line of input) {
          const text = line.trim();
          if (text === '/exit') {
            break;
          }
          if (text === '/clear') {
            history = createHistory();
            provider.reset?.();
            await saveSession(history);
            console.log('历史已清空。');
          } else if (text === '/compact') {
            let compacted;
            try {
              compacted = await compactHistory(history, provider);
            } catch {
              console.error(
                '上下文压缩失败，原历史已保留。可重试或使用 /clear 清空历史。',
              );
            }
            if (compacted === history) {
              console.log('暂无需要压缩的历史。');
            } else if (compacted) {
              await saveSession(compacted);
              history = compacted;
              console.log('上下文已压缩。');
            }
          } else if (text) {
            try {
              await runTurn(text);
            } catch (error) {
              if (!(error instanceof ContextBudgetError)) {
                throw error;
              }
              console.error(error.message);
            }
          }
          input.prompt();
        }
      } finally {
        input.close();
      }
    }
  }
} catch (error) {
  // 只显示已处理的错误提示，避免泄露请求凭据。
  console.error(
    error instanceof ContextBudgetError ||
      (error instanceof Error && error.constructor === Error)
      ? error.message
      : '执行失败，请检查参数、目录或模型连接配置。',
  );
  process.exitCode = EXIT_CODE.ERROR;
}
