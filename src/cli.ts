import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agent-loop.js';
import { createMock } from './mock.js';
import { createTools } from './tools.js';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: 'string', default: 'mock' },
      root: { type: 'string' },
      'max-steps': { type: 'string', default: '6' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      '用法：npm start -- [--mode mock|openai|zenmux] [--root 目录] [--max-steps 1..20] "任务"',
    );
  } else {
    if (!['mock', 'openai', 'zenmux'].includes(values.mode!))
      throw new Error('mode 只能是 mock、openai 或 zenmux');
    const task = positionals.join(' ') || '请读取 welcome.md 并介绍它';
    const root =
      values.root ?? fileURLToPath(new URL('../../demo/', import.meta.url));
    const execute = await createTools(root);
    let model = createMock();
    if (values.mode !== 'mock') {
      // 默认 mock 分支不读取密钥环境变量，也不创建 SDK client。
      const zenmux = values.mode === 'zenmux';
      const keyName = zenmux ? 'ZENMUX_API_KEY' : 'OPENAI_API_KEY';
      const modelName = zenmux ? 'ZENMUX_MODEL' : 'OPENAI_MODEL';
      const key = process.env[keyName];
      const name = process.env[modelName];
      if (!key || !name)
        throw new Error(`真实模式需要用户自行设置 ${keyName} 和 ${modelName}`);
      const { createOpenAI, ZENMUX_BASE_URL } = await import('./openai.js');
      model = createOpenAI(
        key,
        name,
        zenmux ? { baseURL: ZENMUX_BASE_URL } : {},
      );
    }
    console.log(`agent-seed | ${values.mode} | 工作目录：${root}`);
    const result = await runAgent(
      task,
      model,
      execute,
      Number(values['max-steps']),
      console.log,
    );
    console.log(`\n${result.answer}`);
    if (result.status === 'step_limit') process.exitCode = 2;
  }
} catch (error) {
  // SDK 错误可能包含请求细节；不把原始对象或凭据打印出来。
  console.error(
    error instanceof Error && error.constructor === Error
      ? error.message
      : '执行失败，请检查参数、目录或模型连接配置。',
  );
  process.exitCode = 1;
}
