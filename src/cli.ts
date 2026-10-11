import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agent-loop.js';
import { createMockProvider } from './providers/mock.js';
import { createTools } from './tools.js';

const EXIT_CODE = {
  // 参数、文件访问或模型连接等执行异常。
  ERROR: 1,
  // 达到模型请求次数上限，尚未获得最终回答。
  STEP_LIMIT: 2,
} as const;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      // --mode：优先使用命令行参数，其次读取 AGENT_MODE，未配置时使用 mock。
      mode: { type: 'string', default: process.env.AGENT_MODE || 'mock' },
      // --root：工具可访问的根目录；未指定时使用项目的 demo/ 目录。
      root: { type: 'string' },
      // --max-steps：最多请求模型的次数，默认 6；先解析为字符串，再转为数字并校验 1–20。
      'max-steps': { type: 'string', default: '6' },
      // --help：显示命令用法，不执行任务。
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      '用法：npm start -- [--mode mock|zenmux] [--root 目录] [--max-steps 1..20] "任务"\n模式优先级：--mode > AGENT_MODE > mock',
    );
  } else {
    if (!['mock', 'zenmux'].includes(values.mode!)) {
      throw new Error('mode 只能是 mock 或 zenmux');
    }

    const task = positionals.join(' ') || '请读取 welcome.md 并介绍它';

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
    const result = await runAgent(
      task,
      provider,
      execute,
      Number(values['max-steps']),
      console.log,
    );
    console.log(`\n${result.answer}`);
    if (result.status === 'step_limit') {
      process.exitCode = EXIT_CODE.STEP_LIMIT;
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
