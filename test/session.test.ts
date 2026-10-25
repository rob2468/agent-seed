import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session.js';
import {
  createHistory,
  AGENT_STATUS,
  type AgentOutput,
} from '../src/agent-loop.js';
import {
  OUTPUT_TYPE,
  REQUEST_STATUS,
  REQUEST_FAILURE,
  type Provider,
  type SessionStore,
  type StoredSession,
  type Execute,
} from '../src/types.js';
import { createTools } from '../src/tools.js';
import { FileSessionStore } from '../src/session-store.js';
import { messageChunk, completedMessage } from './stream-helpers.js';

function memoryStore() {
  const records = new Map<string, StoredSession>();
  let saves = 0;
  const store: SessionStore = {
    async load(id) {
      const saved = records.get(id);
      if (!saved) {
        throw new Error('会话不存在');
      }
      return structuredClone(saved);
    },
    async latest(root) {
      const entry = [...records]
        .reverse()
        .find(([, value]) => value.root === root);
      if (!entry) {
        throw new Error('会话不存在');
      }
      return entry[0];
    },
    async save(id, saved) {
      saves += 1;
      records.set(id, structuredClone(saved));
    },
  };
  return { store, records, saves: () => saves };
}

function answeringProvider(): Provider {
  return {
    async *reply() {
      yield messageChunk({ role: 'assistant', content: '回答', refusal: null });
    },
    async summarize() {
      return completedMessage({
        role: 'assistant',
        content: '历史摘要',
        refusal: null,
      });
    },
  };
}

const noTools: Execute = async () => {
  assert.fail('不应执行工具');
};

async function collect(stream: AsyncIterable<AgentOutput>) {
  const outputs: AgentOutput[] = [];
  for await (const output of stream) {
    outputs.push(output);
  }
  return outputs;
}

test('Session 在禁止 UI、终端、文件系统模块且无 TTY 的进程中独立运行', () => {
  const loader = `export async function resolve(specifier, context, next) {
    if (/^(ink|react)(\\/|$)|^(node:)?(fs|readline|tty|os)(\\/|$)/.test(specifier)) {
      throw new Error('禁止依赖：' + specifier);
    }
    return next(specifier, context);
  }`;
  const source = `
    import assert from 'node:assert/strict';
    for (const name of ['log', 'warn', 'error']) {
      console[name] = () => { throw new Error('能力层不能打印'); };
    }
    const { Session } = await import(${JSON.stringify(new URL('../src/session.js', import.meta.url).href)});
    const { OUTPUT_TYPE } = await import(${JSON.stringify(new URL('../src/types.js', import.meta.url).href)});
    const provider = { async *reply() {
      yield { choices: [{ index: 0, delta: { content: '独立回答' }, finish_reason: 'stop' }] };
    }};
    const session = new Session({ id: 'virtual', root: 'memory://workspace', provider,
      execute: async () => { throw new Error('不应执行工具'); } });
    const results = [];
    for await (const output of session.run('任务')) {
      results.push(output);
    }
    assert.equal(results.at(-1).type, OUTPUT_TYPE.RESULT);
    assert.equal(results.at(-1).answer, '独立回答');
    assert.equal(process.stdin.isTTY, undefined);
  `;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-loader',
      `data:text/javascript,${encodeURIComponent(loader)}`,
      '--input-type=module',
      '-e',
      source,
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('内存存储支持多轮、显式恢复、手动压缩和清空，保存完成后才产出最终结果', async () => {
  const memory = memoryStore();
  const provider = answeringProvider();
  const session = new Session({
    id: 'session-a',
    root: 'memory://a',
    provider,
    execute: noTools,
    store: memory.store,
  });
  for await (const event of session.run('第一问')) {
    if (event.type === OUTPUT_TYPE.RESULT) {
      assert.equal(memory.saves(), 1);
    }
  }
  const first = structuredClone(session.history);
  await collect(session.run('第二问'));
  assert.deepEqual(session.history.slice(0, first.length), first);
  const id = await memory.store.latest('memory://a');
  const saved = await memory.store.load(id);
  const restored = new Session({
    id,
    ...saved,
    provider: answeringProvider(),
    execute: noTools,
    store: memory.store,
  });
  assert.deepEqual(restored.history, session.history);
  const compacted = await restored.compact();
  assert.equal(compacted.status, REQUEST_STATUS.COMPLETED);
  assert.equal(restored.history[1].role, 'user');
  assert.match(String(restored.history[1].content), /历史摘要/);
  assert.deepEqual(
    restored.history.slice(2),
    session.history.slice(first.length),
  );
  assert.deepEqual((await memory.store.load(id)).history, restored.history);
  await restored.clear();
  assert.deepEqual(restored.history, createHistory());
  assert.deepEqual((await memory.store.load(id)).history, createHistory());
  assert.equal(restored.id, id);
});

for (const approved of [true, false, undefined]) {
  test(`无终端写入确认：${String(approved)}，工具事件携带真实结果`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'headless-write-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const timeline: string[] = [];
    const signal = new AbortController().signal;
    const execute = await createTools(
      root,
      approved === undefined
        ? undefined
        : async (path, content, overwrite, receivedSignal) => {
            timeline.push('confirm');
            assert.equal(path, 'note.txt');
            assert.equal(content, '测试内容');
            assert.equal(overwrite, false);
            assert.equal(receivedSignal, signal);
            return approved;
          },
    );
    const provider: Provider = {
      async *reply(history) {
        if (history.at(-1)?.role === 'user') {
          yield messageChunk({
            role: 'assistant',
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: 'write-1',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({
                    path: 'note.txt',
                    content: '测试内容',
                  }),
                },
              },
            ],
          });
        } else {
          yield messageChunk({
            role: 'assistant',
            content: '写入处理完成',
            refusal: null,
          });
        }
      },
    };
    const session = new Session({ id: 'write', root, provider, execute });
    for await (const event of session.run('写文件', signal)) {
      timeline.push(event.type);
      if (event.type === OUTPUT_TYPE.TOOL_END) {
        assert.equal(event.result.ok, approved === true);
      }
    }
    assert.equal(timeline[0], OUTPUT_TYPE.TOOL_START);
    if (approved !== undefined) {
      assert.equal(timeline[1], 'confirm');
    }
    assert.equal(timeline.at(-1), OUTPUT_TYPE.RESULT);
    if (approved) {
      assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), '测试内容');
    } else {
      await assert.rejects(access(join(root, 'note.txt')));
    }
  });
}

test('在工具开始事件处取消或停止消费，不执行工具、不保存，并回退历史', async () => {
  for (const mode of ['cancel', 'break']) {
    const memory = memoryStore();
    const controller = new AbortController();
    let resets = 0;
    const provider: Provider = {
      reset() {
        resets += 1;
      },
      async *reply() {
        yield messageChunk({
          role: 'assistant',
          content: null,
          refusal: null,
          tool_calls: [
            {
              id: 'read-1',
              type: 'function',
              function: { name: 'read_file', arguments: '{}' },
            },
          ],
        });
      },
    };
    const session = new Session({
      id: mode,
      root: 'virtual',
      provider,
      execute: noTools,
      store: memory.store,
    });
    const previous = structuredClone(session.history);
    const events: AgentOutput[] = [];
    for await (const event of session.run('任务', controller.signal)) {
      events.push(event);
      if (event.type === OUTPUT_TYPE.TOOL_START) {
        if (mode === 'break') {
          break;
        }
        controller.abort();
      }
    }
    if (mode === 'cancel') {
      assert.equal(
        (events.at(-1) as { status: string }).status,
        AGENT_STATUS.CANCELLED,
      );
    }
    assert.deepEqual(session.history, previous);
    assert.equal(memory.saves(), 0);
    assert.equal(resets, 1);
    await session.clear();
  }
});

test('自动压缩产出开始和完成状态，保留当前任务并只保存最终历史', async () => {
  const memory = memoryStore();
  const history = [
    ...createHistory(),
    { role: 'user' as const, content: '旧任务' },
    { role: 'assistant' as const, content: '旧回答' },
  ];
  let calls = 0;
  const provider = answeringProvider();
  const reply = provider.reply;
  provider.reply = async function* (...args) {
    calls += 1;
    if (calls === 1) {
      yield { status: REQUEST_STATUS.BUDGET_EXCEEDED, message: '本地预算不足' };
      return;
    }
    yield* reply(...args);
  };
  const session = new Session({
    id: 'auto',
    root: 'virtual',
    history,
    provider,
    execute: noTools,
    store: memory.store,
  });
  const events = await collect(session.run('当前任务'));
  assert.deepEqual(events.slice(0, 2), [
    { type: OUTPUT_TYPE.COMPACT_START },
    {
      type: OUTPUT_TYPE.COMPACT_END,
      status: REQUEST_STATUS.COMPLETED,
      changed: true,
    },
  ]);
  assert.equal(session.history[2].content, '当前任务');
  assert.equal(memory.saves(), 1);
  assert.deepEqual((await memory.store.load('auto')).history, session.history);
});

test('请求失败和手动压缩取消均不保存，压缩取消保留历史', async () => {
  const memory = memoryStore();
  const provider = answeringProvider();
  provider.reply = async function* () {
    yield {
      status: REQUEST_STATUS.FAILED,
      reason: REQUEST_FAILURE.CONNECTION,
      message: '连接失败',
    };
  };
  const session = new Session({
    id: 'failed',
    root: 'virtual',
    provider,
    execute: noTools,
    store: memory.store,
  });
  const events = await collect(session.run('失败任务'));
  assert.equal(
    (events.at(-1) as { status: string }).status,
    AGENT_STATUS.FAILED,
  );
  const previous = structuredClone(session.history);
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (await session.compact(controller.signal)).status,
    REQUEST_STATUS.CANCELLED,
  );
  assert.deepEqual(session.history, previous);
  assert.equal(memory.saves(), 0);
});

test('保存失败不产出成功结果，释放会话后可重新执行', async () => {
  const memory = memoryStore();
  let fail = true;
  const store: SessionStore = {
    ...memory.store,
    async save(id, snapshot) {
      if (fail) {
        fail = false;
        throw new Error('保存失败');
      }
      await memory.store.save(id, snapshot);
    },
  };
  const session = new Session({
    id: 'save',
    root: 'virtual',
    provider: answeringProvider(),
    execute: noTools,
    store,
  });
  const seen: AgentOutput[] = [];
  await assert.rejects(async () => {
    for await (const event of session.run('任务')) {
      seen.push(event);
    }
  }, /保存失败/);
  assert.ok(seen.every((event) => event.type !== OUTPUT_TYPE.RESULT));
  assert.deepEqual(session.history, createHistory());
  await collect(session.run('重试'));
  assert.equal(memory.saves(), 1);
});

test('消费流期间拒绝并发修改会话，关闭流后恢复可用', async () => {
  const session = new Session({
    id: 'busy',
    root: 'virtual',
    provider: answeringProvider(),
    execute: noTools,
  });
  const stream = session.run('任务');
  await stream.next();
  await assert.rejects(session.clear(), /正在执行/);
  await assert.rejects(session.compact(), /正在执行/);
  await assert.rejects(collect(session.run('并发任务')), /正在执行/);
  await stream.return(undefined);
  assert.deepEqual(session.history, createHistory());
  await collect(session.run('继续'));
  assert.equal(session.history.at(-1)?.content, '回答');
});

test('文件存储目录和警告通知可由外部指定', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'injected-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const warnings: string[] = [];
  const store = new FileSessionStore(directory, (message) =>
    warnings.push(message),
  );
  const id = '11111111-1111-4111-8111-111111111111';
  const bad = '22222222-2222-4222-8222-222222222222';
  const snapshot = { root: directory, history: createHistory() };
  await store.save(id, snapshot);
  await writeFile(join(directory, `${bad}.json`), '{broken');
  assert.equal(await store.latest(directory), id);
  assert.deepEqual(await store.load(id), snapshot);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /跳过会话/);
});
