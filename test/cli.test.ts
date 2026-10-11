import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('CLI 多轮输入、空行、清空、退出与 EOF', () => {
  const result = spawnSync(process.execPath, [cli, '--mode', 'mock'], {
    input: '\n第一问\n第二问\n/clear\n第三问\n/exit\n不应执行\n',
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/Mock 已完成/g) ?? []).length, 3);
  assert.match(result.stdout, /历史 8 条/);
  assert.equal((result.stdout.match(/历史 2 条/g) ?? []).length, 2);
  assert.match(result.stdout, /历史已清空/);

  const eof = spawnSync(process.execPath, [cli, '--mode', 'mock'], {
    input: '读文档\n',
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(eof.status, 0, eof.stderr);
  assert.match(eof.stdout, /Mock 已完成/);
});

test('带任务参数仍单次执行，保留步数上限退出码', () => {
  const result = spawnSync(
    process.execPath,
    [cli, '--mode', 'mock', '--max-steps', '1', '读文档'],
    {
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /达到最大步数/);
});
