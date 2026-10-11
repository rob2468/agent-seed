import { test, type TestContext } from 'node:test';
import fs, { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_LOG_FILE } from '../src/logger.js';
import assert from 'node:assert/strict';
import { EnvHttpProxyAgent, MockAgent } from 'undici';
import { createZenMuxProvider } from '../src/providers/zenmux.js';
import { runAgent } from '../src/agent-loop.js';

async function logFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-seed-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logFile = join(directory, 'logs', 'zenmux.log');
  const mkdir = fs.mkdir;
  const appendFile = fs.appendFile;
  // 仅在测试文件系统层重定向固定路径，provider 不接受日志配置。
  t.mock.method(
    fs,
    'mkdir',
    (...[path, options]: Parameters<typeof fs.mkdir>) => {
      assert.equal(path, dirname(DEFAULT_LOG_FILE));
      return mkdir(dirname(logFile), options);
    },
  );
  t.mock.method(
    fs,
    'appendFile',
    (...[path, data, options]: Parameters<typeof fs.appendFile>) => {
      assert.equal(path, DEFAULT_LOG_FILE);
      return appendFile(logFile, data, options);
    },
  );
  return logFile;
}

function mockTransport(t: TestContext) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const dispatch: EnvHttpProxyAgent['dispatch'] = (options, handler) => {
    // fetch 将正文交给调度器时已是流，先在测试层读完再交给 MockAgent。
    void (async () => {
      let body = '';
      const stream = options.body;
      if (
        stream &&
        typeof stream === 'object' &&
        Symbol.asyncIterator in stream
      ) {
        for await (const chunk of stream) {
          body += Buffer.from(chunk).toString('utf8');
        }
      } else {
        body = String(stream ?? '');
      }
      agent.dispatch({ ...options, body }, handler);
    })().catch((error) => handler.onError?.(error));
    return true;
  };
  t.mock.method(EnvHttpProxyAgent.prototype, 'dispatch', dispatch);
  t.after(async () => {
    await agent.close();
  });
  return agent.get('https://zenmux.ai');
}

// 在测试中拦截 undici 调度，不向 provider 注入 fetch，也不建立网络连接。
test('ZenMux SDK provider 发送协议字段并将工具结果带到下一轮', async (t) => {
  const logFile = await logFixture(t);
  const requests: Record<string, any>[] = [];
  const pool = mockTransport(t);
  pool
    .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
    .defaultReplyHeaders({ 'content-type': 'application/json' })
    .reply((options) => {
      assert.equal(
        new Headers(options.headers as Record<string, string>).get(
          'authorization',
        ),
        'Bearer test-only-not-a-credential',
      );

      const body = JSON.parse(String(options.body));
      requests.push(body);

      const first = requests.length === 1;
      return {
        statusCode: 200,
        data: {
          id: 'test-completion',
          object: 'chat.completion',
          created: 0,
          model: 'example/tool-model',
          choices: [
            {
              index: 0,
              finish_reason: first ? 'tool_calls' : 'stop',
              message: first
                ? {
                    role: 'assistant',
                    content: null,
                    refusal: null,
                    tool_calls: [
                      {
                        id: 'read-1',
                        type: 'function',
                        function: {
                          name: 'read_file',
                          arguments: '{"path":"welcome.md"}',
                        },
                      },
                    ],
                  }
                : { role: 'assistant', content: '已收到工具结果' },
            },
          ],
        },
      };
    })
    .times(2);

  const provider = createZenMuxProvider(
    'test-only-not-a-credential',
    'example/tool-model',
  );

  const result = await runAgent(
    '读取文档',
    provider,
    async (call) => {
      assert.equal(call.function.name, 'read_file');
      assert.equal(call.function.arguments, '{"path":"welcome.md"}');
      return { ok: true, data: { text: '内存中的示例内容' } };
    },
    3,
  );
  assert.equal(result.status, 'answered');
  assert.equal(requests.length, 2);

  assert.equal(requests[0].model, 'example/tool-model');
  assert.equal(requests[0].max_completion_tokens, 2048);
  assert.deepEqual(
    requests[0].tools.map((t: any) => t.function.name),
    ['list_directory', 'read_file'],
  );

  assert.equal(requests[1].messages[2].tool_calls[0].id, 'read-1');
  assert.deepEqual(requests[1].messages[2], {
    role: 'assistant',
    content: null,
    refusal: null,
    tool_calls: [
      {
        id: 'read-1',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: '{"path":"welcome.md"}',
        },
      },
    ],
  });
  assert.deepEqual(requests[1].messages[3], {
    role: 'tool',
    tool_call_id: 'read-1',
    content: JSON.stringify({ ok: true, data: { text: '内存中的示例内容' } }),
  });
});

test('ZenMux API 错误不自动重试', async (t) => {
  const logFile = await logFixture(t);
  const pool = mockTransport(t);
  pool
    .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
    .reply(503, { error: { message: 'offline simulated failure' } });
  const provider = createZenMuxProvider(
    'test-only-not-a-credential',
    'example/tool-model',
  );

  await assert.rejects(
    provider.reply([{ role: 'user', content: 'test' }]),
    (error: any) => error.status === 503,
  );
  const log = await readFile(logFile, 'utf8');
  assert.ok(log.includes('{"error":{"message":"offline simulated failure"}}'));
  assert.ok(!log.includes('test-only-not-a-credential'));
});

test('日志原样保留请求与响应正文，不记录认证头', async (t) => {
  const logFile = await logFixture(t);
  const responseBody =
    '{ "choices": [{ "finish_reason": "stop", "message": { "role": "assistant", "content": "你好", "refusal": null } }], "usage": { "total_tokens": 9 }, "extra": [1, null] }';
  let requestBody = '';
  const pool = mockTransport(t);
  pool
    .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
    .reply((options) => {
      requestBody = String(options.body);
      return {
        statusCode: 200,
        data: responseBody,
        responseOptions: {
          headers: {
            'content-type': 'application/json',
            'x-test-header': 'not-for-logs',
          },
        },
      };
    });
  const provider = createZenMuxProvider(
    'test-secret-not-for-logs',
    'example/model',
  );

  await provider.reply([{ role: 'user', content: '你好' }]);
  const log = await readFile(logFile, 'utf8');
  assert.ok(log.includes(`request\n${requestBody}\n\n`));
  assert.ok(log.includes(`response\n${responseBody}\n\n`));
  const ids = [...log.matchAll(/\] \[([^\]]+)\] (?:request|response)/g)].map(
    (match) => match[1],
  );
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.ok(!log.includes('test-secret-not-for-logs'));
  assert.ok(!log.includes('authorization'));
  assert.ok(!log.includes('x-test-header'));
});
