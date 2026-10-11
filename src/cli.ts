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
      // --mode：优先使用命令行参数，其次读取 AGENT_MODE，未配置时使用 mock。
      mode: { type: 'string', default: process.env.AGENT_MODE || 'mock' },
      // --root：工具可访问的根目录；未指定时使用项目的 demo/ 目录。
      root: { type: 'string' },
      // --max-model-calls：最多请求模型的次数，默认 6；先解析为字符串，再转为数字并校验 1–20。
      'max-model-calls': { type: 'string', default: '6' },
      // --help：显示命令用法，不执行任务。
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      '用法：npm start -- [--mode mock|zenmux] [--root 目录] [--max-model-calls 1..20] ["任务"]\n不带任务进入多轮会话：/clear 清空历史，/exit 退出。\n模式优先级：--mode > AGENT_MODE > mock',
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
      // 默认 mock 分支不读取密钥环境变量，也不创建 SDK client。
      const key = process.env.ZENMUX_API_KEY;
      const name = process.env.ZENMUX_MODEL;
      if (!key || !name) {
        throw new Error('ZenMux 模式需要设置 ZENMUX_API_KEY 和 ZENMUX_MODEL');
      }

      const { createZenMuxProvider } = await import('./providers/zenmux.js');
      provider = createZenMuxProvider(key, name);
    }

    console.log(`agent-seed | ${values.mode} | 工作目录：${root}`);
    let history = createHistory();
    const runTurn = async (input: string) => {
      const result = await runAgent(
        input,
        provider,
        execute,
        maxModelCalls,
        history,
      );
      console.log(`\n${result.answer}`);
      return result;
    };

    if (task) {
      const result = await runTurn(task);
      if (result.status === AGENT_STATUS.MODEL_CALL_LIMIT) {
        process.exitCode = EXIT_CODE.MODEL_CALL_LIMIT;
      }
    } else {
      console.log('输入任务开始对话；/clear 清空历史，/exit 退出。');
      const input = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      input.setPrompt('你：');
      input.prompt();
      try {
        // 按顺序消费输入；当前轮次完成后才处理下一条用户消息。
        for await (const line of input) {
          const text = line.trim();
          if (text === '/exit') {
            break;
          }
          if (text === '/clear') {
            history = createHistory();
            console.log('历史已清空。');
          } else if (text) {
            await runTurn(text);
          }
          input.prompt();
        }
      } finally {
        input.close();
      }
    }
  }
} catch (error) {
  // SDK 错误可能包含请求细节；不把原始对象或凭据打印出来。
  console.error(
    error instanceof Error && error.constructor === Error
      ? error.message
      : '执行失败，请检查参数、目录或模型连接配置。',
  );
  process.exitCode = EXIT_CODE.ERROR;
}
