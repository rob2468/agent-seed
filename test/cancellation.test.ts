import { completeAgent, messageChunk } from './stream-helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHistory } from '../src/agent-loop.js';
import { compactHistory } from '../src/compact.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('取消后不执行第二个工具，也不再请求模型', async () => {
  const controller = new AbortController();
  let calls = 0;
  let tools = 0;
  await assert.rejects(
    completeAgent(
      '任务',
      {
        provider: {
          async *reply() {
            calls += 1;
            yield messageChunk({
              role: 'assistant',
              content: null,
              refusal: null,
              tool_calls: ['a', 'b'].map((id) => ({
                id,
                type: 'function' as const,
                function: { name: 'read_file', arguments: '{}' },
              })),
            });
            return;
          },
        },
        execute: async () => {
          tools += 1;
          controller.abort();
          return { ok: true, data: '完成' };
        },
        maxModelCalls: 6,
        history: createHistory(),
      },
      controller.signal,
    ),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
  assert.equal(tools, 1);
});

test('摘要返回时已取消，不替换历史或重置基准', async () => {
  const controller = new AbortController();
  const history = createHistory();
  history.push({ role: 'user', content: '原任务' });
  const original = structuredClone(history);
  await assert.rejects(
    compactHistory(
      history,
      {
        async *reply() {
          throw new Error('不应调用');
        },
        async summarize() {
          controller.abort();
          return { role: 'assistant', content: '摘要', refusal: null };
        },
        reset() {
          assert.fail('取消后不能提交摘要');
        },
      },
      controller.signal,
    ),
    { name: 'AbortError' },
  );
  assert.deepEqual(history, original);
});

for (const mode of ['turn', 'compact', 'single']) {
  test(
    `CLI 取消 ${mode} 保留会话并正确继续或退出`,
    { timeout: 10000 },
    async (t) => {
      const cwd = await mkdtemp(join(tmpdir(), 'agent-cancel-'));
      t.after(() => rm(cwd, { recursive: true, force: true }));
      await mkdir(join(cwd, '.agent-seed'));
      const file = join(cwd, '.agent-seed/session.json');
      const history = createHistory();
      history.push({ role: 'user', content: '此前任务' });
      history.push({ role: 'assistant', content: '此前回答' });
      const original = JSON.stringify(history);
      await writeFile(file, original);

      // 在 SDK 层模拟等待中的请求，检查 signal 实际传到了 SDK。
      const preload = `
      import { Completions } from ${JSON.stringify(import.meta.resolve('openai/resources/chat/completions'))};
      let calls = 0;
      Completions.prototype.create = async function(body, options) {
        calls += 1;
        if (calls === 1) {
          if (!options?.signal) throw new Error('missing signal');
          const wait = () => new Promise((resolve, reject) => {
            const timer = setInterval(() => {}, 1000);
            options.signal.addEventListener('abort', () => {
              clearInterval(timer);
              reject(options.signal.reason);
            }, { once: true });
            console.log('REQUEST_WAITING');
          });
          if (body.stream) {
            return {
              controller: new AbortController(),
              async *[Symbol.asyncIterator]() {
                yield { id:'test', object:'chat.completion.chunk', created:0, model:'test', choices:[{index:0, delta:{role:'assistant', content:'尚未完成的文本'}, finish_reason:null}] };
                await wait();
              },
            };
          }
          return wait();
        }
        if (body.stream) {
          return {
            controller: new AbortController(),
            async *[Symbol.asyncIterator]() {
              yield {id:'test', object:'chat.completion.chunk', created:0, model:'test', choices:[{index:0, delta:{role:'assistant', content:'继续成功'}, finish_reason:'stop'}], usage:{total_tokens:10}};
            },
          };
        }
        return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '继续成功', refusal: null } }], usage: { total_tokens: 10 } };
      };
    `;
      const args = [
        '--import',
        `data:text/javascript,${encodeURIComponent(preload)}`,
        cli,
        '--mode',
        'zenmux',
      ];
      if (mode === 'single') {
        args.push('取消这轮');
      }
      const child = spawn(process.execPath, args, {
        cwd,
        env: {
          ...process.env,
          ZENMUX_API_KEY: 'test-key',
          ZENMUX_MODEL: 'test-model',
          ZENMUX_CONTEXT_WINDOW: '128000',
          ZENMUX_MAX_OUTPUT_TOKENS: '2048',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      t.after(() => {
        child.kill('SIGKILL');
      });
      let output = '';
      let errors = '';
      let interrupted = false;
      let continued = false;
      child.stderr.on('data', (chunk) => {
        errors += chunk;
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (!interrupted && output.includes('REQUEST_WAITING')) {
          interrupted = true;
          child.kill('SIGINT');
        }
        if (
          mode !== 'single' &&
          !continued &&
          output.includes('任务已取消。')
        ) {
          continued = true;
          child.stdin.end('继续任务\n/exit\n');
        }
      });
      if (mode !== 'single') {
        child.stdin.write(mode === 'compact' ? '/compact\n' : '取消这轮\n');
      }
      const code = await closed;
      assert.equal(code, mode === 'single' ? 130 : 0, errors);
      assert.match(output, /任务已取消/);
      assert.doesNotMatch(errors, /连接失败|请求超时|压缩失败/);
      if (mode === 'single') {
        assert.equal(await readFile(file, 'utf8'), original);
      } else {
        const saved = JSON.parse(await readFile(file, 'utf8'));
        assert.deepEqual(saved.slice(0, history.length), history);
        assert.equal(saved.length, history.length + 2);
        assert.equal(saved.at(-2).content, '继续任务');
        assert.equal(saved.at(-1).content, '继续成功');
      }
    },
  );
}

test('任务开始前已取消，不修改历史或调用模型', async () => {
  const controller = new AbortController();
  controller.abort();
  const history = createHistory();
  const original = structuredClone(history);
  const provider = {
    async *reply() {
      assert.fail('不应调用模型');
    },
    async summarize(): Promise<never> {
      assert.fail('不应请求摘要');
    },
  };
  await assert.rejects(
    completeAgent(
      '任务',
      {
        provider: provider,
        execute: async () => {
          assert.fail('不应执行工具');
        },
        maxModelCalls: 6,
        history: history,
      },
      controller.signal,
    ),
    { name: 'AbortError' },
  );
  await assert.rejects(compactHistory(history, provider, controller.signal), {
    name: 'AbortError',
  });
  assert.deepEqual(history, original);
});

test('模型返回时已取消，不追加回复或执行工具', async () => {
  const controller = new AbortController();
  const history = createHistory();
  await assert.rejects(
    completeAgent(
      '任务',
      {
        provider: {
          async *reply() {
            controller.abort();
            yield messageChunk({
              role: 'assistant',
              content: null,
              refusal: null,
              tool_calls: [
                {
                  id: 'a',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{}' },
                },
              ],
            });
            return;
          },
        },
        execute: async () => {
          assert.fail('不应执行工具');
        },
        maxModelCalls: 6,
        history: history,
      },
      controller.signal,
    ),
    { name: 'AbortError' },
  );
  assert.equal(history.length, 2);
  assert.equal(history.at(-1)?.role, 'user');
});
