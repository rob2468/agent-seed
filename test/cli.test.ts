import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function sessionDirectory(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-seed-session-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// 只在测试进程替换模型响应，生产 CLI 始终创建 ZenMuxProvider。
const preload = `
import { ZenMuxProvider } from ${JSON.stringify(new URL('../src/providers/zenmux.js', import.meta.url).href)};
import { createMockProvider } from ${JSON.stringify(new URL('./mock-provider.js', import.meta.url).href)};
const provider = createMockProvider();
ZenMuxProvider.prototype.reply = provider.reply;
ZenMuxProvider.prototype.summarize = provider.summarize;
process.env.ZENMUX_API_KEY = 'test';
process.env.ZENMUX_MODEL = 'test';
`;
const cliArgs = [
  '--import',
  'data:text/javascript,' + encodeURIComponent(preload),
  cli,
];

test('CLI 多轮输入、空行、清空、退出与 EOF', (t) => {
  const cwd = sessionDirectory(t);
  const result = spawnSync(process.execPath, [...cliArgs], {
    input: '\n第一问\n第二问\n/clear\n第三问\n/exit\n不应执行\n',
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/Mock 已完成/g) ?? []).length, 3);
  assert.doesNotMatch(
    result.stdout,
    /轮次|模型调用 \d|请求模型，历史|工具调用 (list_directory|read_file)|工具结果 \{/,
  );
  assert.match(result.stdout, /历史已清空/);

  const eof = spawnSync(process.execPath, [...cliArgs], {
    input: '读文档\n',
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(eof.status, 0, eof.stderr);
  assert.match(eof.stdout, /Mock 已完成/);
});

test('带任务参数仍单次执行，保留模型调用次数上限退出码', (t) => {
  const cwd = sessionDirectory(t);
  const result = spawnSync(
    process.execPath,
    [...cliArgs, '--max-model-calls', '1', '读文档'],
    {
      cwd,
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /达到模型调用次数上限/);
});

test('CLI 手动压缩后可以继续对话、再次压缩和清空', (t) => {
  const cwd = sessionDirectory(t);
  const result = spawnSync(process.execPath, [...cliArgs], {
    input:
      '/compact\n第一问\n/compact\n第二问\n/compact\n/clear\n/compact\n/exit\n',
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/上下文已压缩/g) ?? []).length, 2);
  assert.equal((result.stdout.match(/暂无需要压缩的历史/g) ?? []).length, 2);
  assert.equal((result.stdout.match(/Mock 已完成/g) ?? []).length, 2);
});

test('重启恢复历史，单次任务也保存，压缩和清空更新文件', (t) => {
  const cwd = sessionDirectory(t);
  const file = join(cwd, '.agent-seed/session.json');
  const run = (input: string, task?: string) => {
    const args = [...cliArgs];
    if (task) {
      args.push(task);
    }
    const result = spawnSync(process.execPath, args, {
      cwd,
      input,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(file, 'utf8'));
  };

  const first = run('第一问\n/exit\n');
  const second = run('', '第二问');
  assert.deepEqual(second.slice(0, first.length), first);
  assert.equal(
    second.filter((message: any) => message.role === 'user').length,
    2,
  );

  const compacted = run('/compact\n/exit\n');
  assert.equal(compacted.length, 2);
  assert.deepEqual(compacted[0], first[0]);
  assert.match(compacted[1].content, /此前对话的摘要/);
  const continued = run('继续任务\n/exit\n');
  assert.deepEqual(continued.slice(0, 2), compacted);

  const cleared = run('/clear\n/exit\n');
  assert.deepEqual(cleared, [first[0]]);
  assert.deepEqual(run('/exit\n'), cleared);
});

test('损坏的会话文件报错并保留原内容', (t) => {
  const cwd = sessionDirectory(t);
  mkdirSync(join(cwd, '.agent-seed'));
  const file = join(cwd, '.agent-seed/session.json');
  for (const body of ['{broken', '{}', '[]', '[{"role":"invalid"}]']) {
    writeFileSync(file, body);
    const result = spawnSync(process.execPath, [...cliArgs], {
      cwd,
      input: '不能覆盖\n',
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /会话文件格式无效/);
    assert.equal(readFileSync(file, 'utf8'), body);
  }
});

test('启动需要 ZenMux 配置，帮助信息不依赖配置且不再提供模式选择', (t) => {
  const cwd = sessionDirectory(t);
  const env = { ...process.env, ZENMUX_API_KEY: '', ZENMUX_MODEL: '' };
  const missing = spawnSync(process.execPath, [cli, '任务'], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /需要设置 ZENMUX_API_KEY 和 ZENMUX_MODEL/);

  const help = spawnSync(process.execPath, [cli, '--help'], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /--mode|mock|AGENT_MODE/);
});
