import { readStream } from '../src/read-stream.js';
import { OUTPUT_TYPE } from '../src/types.js';
import {
  completeAgent,
  completeReply,
  messageChunk,
} from './stream-helpers.js';
import { ContextBudgetError, estimateTokens } from '../src/context-budget.js';
import OpenAI from 'openai';
import { Completions } from 'openai/resources/chat/completions';
import { test, type TestContext } from 'node:test';
import fs, { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_LOG_FILE } from '../src/logger.js';
import assert from 'node:assert/strict';
import { EnvHttpProxyAgent, MockAgent } from 'undici';
import { ZenMuxProvider } from '../src/providers/zenmux.js';
import { AGENT_STATUS, createHistory, runAgent } from '../src/agent-loop.js';

async function logFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-seed-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logFile = join(directory, 'logs', 'zenmux.log');
  const mkdir = fs.mkdir;
  const appendFile = fs.appendFile;
  // 将测试日志写入临时目录。
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
    // 将请求正文流读成字符串，再交给 MockAgent。
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
  const pool = agent.get('https://zenmux.ai');
  const intercept = pool.intercept.bind(pool);
  // 旧的完整回复夹具按请求类型生成 SSE，摘要仍返回原始 JSON。
  pool.intercept = (options) => {
    const interceptor = intercept(options);
    const reply = interceptor.reply.bind(interceptor);
    interceptor.reply = ((status: any, data?: any, responseOptions?: any) =>
      reply((request: any) => {
        let response;
        if (typeof status === 'function') {
          response = status(request);
        } else {
          response = {
            statusCode: status,
            data: typeof data === 'function' ? data(request) : data,
            responseOptions: responseOptions ?? {},
          };
        }
        if (
          JSON.parse(String(request.body)).stream &&
          response.statusCode === 200 &&
          typeof response.data !== 'string'
        ) {
          const completion = response.data;
          const chunk = messageChunk(completion.choices[0].message);
          chunk.choices[0].finish_reason = completion.choices[0].finish_reason;
          chunk.usage = completion.usage;
          response.data =
            'data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n';
          response.responseOptions = {
            headers: { 'content-type': 'text/event-stream' },
          };
        }
        return response;
      })) as typeof interceptor.reply;
    return interceptor;
  };
  return pool;
}

// 拦截 undici 请求，使用模拟响应。
test('ZenMux SDK provider 发送协议字段并将工具结果带到下一次模型调用', async (t) => {
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

  const provider = new ZenMuxProvider(
    'test-only-not-a-credential',
    'example/tool-model',
  );

  const result = await completeAgent('读取文档', {
    provider: provider,
    execute: async (call) => {
      assert.equal(call.function.name, 'read_file');
      assert.equal(call.function.arguments, '{"path":"welcome.md"}');
      return { ok: true, data: { text: '内存中的示例内容' } };
    },
    maxModelCalls: 3,
    history: createHistory(),
  });
  assert.equal(result.status, AGENT_STATUS.ANSWERED);
  assert.equal(requests.length, 2);
  const log = await readFile(logFile, 'utf8');
  for (const modelCall of [1, 2]) {
    assert.ok(log.includes(`[turn=1] [modelCall=${modelCall}]`));
  }
  assert.ok(!('turn' in requests[0]));
  assert.ok(!('modelCall' in requests[0]));
  assert.ok(!('estimatedInputTokens' in requests[0]));
  assert.match(log, /\[totalTokens=unknown\]/);

  assert.equal(requests[0].model, 'example/tool-model');
  assert.equal(requests[0].max_completion_tokens, 2048);
  assert.deepEqual(
    requests[0].tools.map((t: any) => t.function.name),
    ['list_directory', 'read_file', 'write_file'],
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
  const provider = new ZenMuxProvider(
    'test-only-not-a-credential',
    'example/tool-model',
  );

  await assert.rejects(
    completeReply(
      provider.reply([{ role: 'user', content: 'test' }], {
        turn: 2,
        modelCall: 3,
      }),
    ),
    {
      message: 'ZenMux 接口错误（HTTP 503），请检查服务状态或请求配置。',
    },
  );
  const log = await readFile(logFile, 'utf8');
  assert.ok(log.includes('{"error":{"message":"offline simulated failure"}}'));
  assert.ok(!log.includes('test-only-not-a-credential'));
});

test('日志原样保留请求与响应正文，不记录认证头', async (t) => {
  const logFile = await logFixture(t);
  const responseBody =
    '{ "choices": [{ "finish_reason": "stop", "message": { "role": "assistant", "content": "你好", "refusal": null } }], "usage": { "prompt_tokens": 6, "completion_tokens": 3, "total_tokens": 9, "prompt_tokens_details": { "cached_tokens": 4 }, "completion_tokens_details": { "reasoning_tokens": 2 } }, "extra": [1, null] }';
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
  const provider = new ZenMuxProvider(
    'test-secret-not-for-logs',
    'example/model',
  );

  await provider.summarize!([{ role: 'user', content: '你好' }], {
    turn: 2,
    modelCall: 3,
  });
  const log = await readFile(logFile, 'utf8');
  assert.ok(log.includes(`request\n${requestBody}\n\n`));
  assert.ok(log.includes(`response\n${responseBody}\n\n`));
  const ids = [
    ...log.matchAll(
      /\] \[([^\]]+)\] \[turn=2\] \[modelCall=3\](?: \[[^\]]+\])* (?:request|response)/g,
    ),
  ].map((match) => match[1]);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.ok(!log.includes('test-secret-not-for-logs'));
  assert.ok(!log.includes('authorization'));
  assert.ok(!log.includes('x-test-header'));
  const requestHeader = log
    .split('\n')
    .find((line) => line.endsWith(' request'))!;
  const responseHeader = log
    .split('\n')
    .find((line) => line.endsWith(' response'))!;
  assert.match(
    requestHeader,
    /\[lastTotalTokens=unknown\] \[addedTokens=\d+\]/,
  );
  assert.doesNotMatch(requestHeader, /\[totalTokens=/);
  assert.match(responseHeader, /\[totalTokens=9\] response$/);
  assert.doesNotMatch(
    responseHeader,
    /\[(lastTotalTokens|addedTokens|promptTokens|completionTokens|cachedTokens|reasoningTokens)=/,
  );
  assert.doesNotMatch(
    log,
    /\[(contextWindow|maxOutputTokens|inputBudget|budgetStatus|baselineSource|baselineTokens|estimatedInputTokens)=/,
  );
});

test('SDK 超时与连接异常使用固定提示，不泄露原始错误', async (t) => {
  const secret = 'Bearer test-secret-must-not-appear';
  const cases = [
    [
      new OpenAI.APIConnectionTimeoutError({ message: secret }),
      'ZenMux 请求超时（120 秒），请稍后重试。',
    ],
    [
      new OpenAI.APIConnectionError({
        message: secret,
        cause: new Error(secret),
      }),
      'ZenMux 连接失败，请检查网络或代理配置。',
    ],
    [
      new OpenAI.APIError(
        401,
        { message: secret },
        secret,
        new Headers({ authorization: secret }),
      ),
      'ZenMux 接口错误（HTTP 401），请检查服务状态或请求配置。',
    ],
  ] as const;
  for (const [failure, message] of cases) {
    const mock = t.mock.method(Completions.prototype, 'create', () => {
      throw failure;
    });
    try {
      const provider = new ZenMuxProvider(
        'test-only-not-a-credential',
        'example/tool-model',
      );
      await assert.rejects(
        completeReply(
          provider.reply([{ role: 'user', content: 'hi' }], {
            turn: 2,
            modelCall: 3,
          }),
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, message);
          assert.equal(error.cause, undefined);
          assert.ok(!String(error).includes(secret));
          return true;
        },
      );
    } finally {
      mock.mock.restore();
    }
  }
});

test('上次实际用量作为基准，请求前超预算拦截，清空后可重新调用', async (t) => {
  const previous = process.env.ZENMUX_CONTEXT_WINDOW;
  process.env.ZENMUX_CONTEXT_WINDOW = '4000';
  t.after(() => {
    if (previous === undefined) {
      delete process.env.ZENMUX_CONTEXT_WINDOW;
    } else {
      process.env.ZENMUX_CONTEXT_WINDOW = previous;
    }
  });
  const logFile = await logFixture(t);
  t.mock.method(console, 'warn', () => {});
  const pool = mockTransport(t);
  pool
    .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
    .defaultReplyHeaders({ 'content-type': 'application/json' })
    .reply(200, {
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: '完成' },
        },
      ],
      usage: { prompt_tokens: 2500, completion_tokens: 10, total_tokens: 2510 },
    })
    .times(2);
  const provider = new ZenMuxProvider('test-key', 'example/model');
  const history = [{ role: 'user' as const, content: '文'.repeat(2000) }];
  const reply = await completeReply(
    provider.reply(history, { turn: 1, modelCall: 1 }),
  );
  const sharedHistory: import('openai/resources/chat/completions').ChatCompletionMessageParam[] =
    history;
  sharedHistory.push(reply);
  const original = structuredClone(sharedHistory);
  await assert.rejects(
    completeReply(provider.reply(sharedHistory, { turn: 2, modelCall: 1 })),
    ContextBudgetError,
  );
  assert.deepEqual(sharedHistory, original);
  const beforeClear = await readFile(logFile, 'utf8');
  assert.equal((beforeClear.match(/ request\n/g) ?? []).length, 1);

  provider.reset?.();
  const fresh = [{ role: 'user' as const, content: '清空后' }];
  await completeReply(provider.reply(fresh, { turn: 1, modelCall: 1 }));
  const log = await readFile(logFile, 'utf8');
  assert.equal((log.match(/ request\n/g) ?? []).length, 2);
  assert.match(log, /\[lastTotalTokens=unknown\]/);
});

test('服务端上下文超限明确提示并保留原始错误日志', async (t) => {
  const logFile = await logFixture(t);
  const pool = mockTransport(t);
  pool
    .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
    .reply(413, {
      error: { type: 'invalid_params', message: 'Prompt is too long' },
    });
  const provider = new ZenMuxProvider('test-key', 'example/model');
  await assert.rejects(
    completeReply(
      provider.reply([{ role: 'user', content: 'hi' }], {
        turn: 1,
        modelCall: 1,
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ContextBudgetError);
      assert.match(error.message, /上下文超限/);
      return true;
    },
  );
  assert.match(await readFile(logFile, 'utf8'), /Prompt is too long/);
});

test('仅估算新增消息，回答不重复计数，缺失 usage 后回退', async (t) => {
  const logFile = await logFixture(t);
  const pool = mockTransport(t);
  const reply = { role: 'assistant' as const, content: '回答', refusal: null };
  const response = { choices: [{ finish_reason: 'stop', message: reply }] };
  pool
    .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
    .defaultReplyHeaders({ 'content-type': 'application/json' })
    .reply(200, {
      ...response,
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        total_tokens: 1100,
      },
    });
  pool
    .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
    .defaultReplyHeaders({ 'content-type': 'application/json' })
    .reply(200, response)
    .times(2);

  const provider = new ZenMuxProvider('test-key', 'example/model');
  const history: import('openai/resources/chat/completions').ChatCompletionMessageParam[] =
    [{ role: 'user', content: '第一问' }];
  history.push(
    await completeReply(provider.reply(history, { turn: 1, modelCall: 1 })),
  );
  const added = { role: 'user' as const, content: '继续' };
  history.push(added);
  history.push(
    await completeReply(provider.reply(history, { turn: 2, modelCall: 1 })),
  );
  history.push({ role: 'user', content: '第三问' });
  await completeReply(provider.reply(history, { turn: 3, modelCall: 1 }));

  const headers = (await readFile(logFile, 'utf8'))
    .split('\n')
    .filter((line) => line.endsWith(' request'));
  assert.match(headers[1], /\[lastTotalTokens=1100\]/);
  assert.ok(headers[1].includes(`[addedTokens=${estimateTokens([added])}]`));
  assert.match(headers[2], /\[lastTotalTokens=unknown\]/);
});

test('摘要请求不发送工具，不覆盖原会话基准，仍记录原始正文', async (t) => {
  const logFile = await logFixture(t);
  const pool = mockTransport(t);
  const requests: any[] = [];
  for (const totalTokens of [100, 200, 300]) {
    pool
      .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
      .defaultReplyHeaders({ 'content-type': 'application/json' })
      .reply(200, (options) => {
        requests.push(JSON.parse(String(options.body)));
        return {
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: '摘要或回答',
                refusal: null,
              },
            },
          ],
          usage: {
            prompt_tokens: totalTokens - 10,
            completion_tokens: 10,
            total_tokens: totalTokens,
          },
        };
      });
  }
  const provider = new ZenMuxProvider('test-key', 'example/model');
  const history: import('openai/resources/chat/completions').ChatCompletionMessageParam[] =
    [{ role: 'user', content: '读取文件' }];
  history.push(
    await completeReply(provider.reply(history, { turn: 1, modelCall: 1 })),
  );
  await provider.summarize!([{ role: 'user', content: '总结记录' }], {
    turn: 1,
    modelCall: 1,
  });
  history.push({ role: 'user', content: '继续' });
  await completeReply(provider.reply(history, { turn: 2, modelCall: 1 }));
  assert.ok(requests[0].tools);
  assert.ok(!('tools' in requests[1]));
  assert.equal(requests[1].messages[0].content, '总结记录');
  const log = await readFile(logFile, 'utf8');
  const headers = log.split('\n').filter((line) => line.endsWith(' request'));
  assert.match(headers[1], /\[lastTotalTokens=unknown\]/);
  assert.match(headers[2], /\[lastTotalTokens=100\]/);
  assert.ok(log.includes('总结记录'));
  assert.match(log, /\[totalTokens=200\] response/);
});

test('流式请求保留原始 SSE、拼接多个工具调用并更新用量基准', async (t) => {
  const logFile = await logFixture(t);
  const pool = mockTransport(t);
  const chunks = [
    {
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: '正在读取',
            tool_calls: [
              {
                index: 0,
                id: 'a',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":' },
              },
              {
                index: 1,
                id: 'b',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 1, function: { arguments: 'b.txt"}' } },
              { index: 0, function: { arguments: '"a.txt"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    {
      choices: [],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    },
  ];
  const body =
    chunks
      .map(
        (chunk) =>
          'data: ' +
          JSON.stringify({
            id: 'stream-test',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test',
            ...chunk,
          }) +
          '\n\n',
      )
      .join('') + 'data: [DONE]\n\n';
  pool
    .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
    .defaultReplyHeaders({ 'content-type': 'text/event-stream' })
    .reply((options) => {
      const request = JSON.parse(String(options.body));
      assert.equal(request.stream, true);
      assert.deepEqual(request.stream_options, { include_usage: true });
      return { statusCode: 200, data: body };
    });
  const provider = new ZenMuxProvider('stream-secret', 'test');
  const history = createHistory();
  let output = '';
  let reply;
  for await (const part of readStream(
    provider.reply(history, { turn: 1, modelCall: 1 }),
  )) {
    if (part.type === OUTPUT_TYPE.TEXT) {
      output += part.text;
    } else {
      reply = part.message;
    }
  }
  assert.ok(reply);
  assert.equal(output, '正在读取\n');
  assert.deepEqual(
    reply.tool_calls?.map(
      (call) => call.type === 'function' && call.function.arguments,
    ),
    ['{"path":"a.txt"}', '{"path":"b.txt"}'],
  );
  const log = await readFile(logFile, 'utf8');
  assert.ok(log.includes('response\n' + body + '\n\n'));
  assert.match(log, /\[totalTokens=30\]/);
  assert.doesNotMatch(log, /stream-secret|authorization/);

  history.push(reply);
  pool
    .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
    .defaultReplyHeaders({ 'content-type': 'application/json' })
    .reply(200, {
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: '完成', refusal: null },
        },
      ],
    });
  await completeReply(provider.reply(history, { turn: 1, modelCall: 2 }));
  assert.match(
    await readFile(logFile, 'utf8'),
    /\[lastTotalTokens=30\] \[addedTokens=0\]/,
  );
});

test('首段文本在响应结束前显示，流中断不返回半条消息', async (t) => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(Completions.prototype, 'create', async () => ({
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      yield {
        id: 'test',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '第一段' },
            finish_reason: null,
          },
        ],
      };
      await waiting;
      throw new Error('流中断');
    },
  }));
  const provider = new ZenMuxProvider('test', 'test');
  const output = readStream(
    provider.reply(createHistory(), { turn: 1, modelCall: 1 }),
  );
  assert.deepEqual(await output.next(), {
    done: false,
    value: { type: OUTPUT_TYPE.TEXT, text: '第一段' },
  });
  const next = output.next();
  const rejected = assert.rejects(next, /流中断/);
  release();
  await rejected;
});

test('流缺少结束原因时不执行工具，也不追加助手消息', async (t) => {
  t.mock.method(Completions.prototype, 'create', async () => ({
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      yield {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'a',
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: '{"path":"a.txt","content":"内容"}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
    },
  }));
  const history = createHistory();
  await assert.rejects(
    completeAgent('写入', {
      provider: new ZenMuxProvider('test', 'test'),
      history,
      maxModelCalls: 6,
      async execute() {
        assert.fail('响应不完整时不能执行工具');
      },
    }),
    /模型响应缺失/,
  );
  assert.deepEqual(
    history.map((message) => message.role),
    ['system', 'user'],
  );
});

test('停止读取 Agent 输出会关闭模型流，不执行工具或提交回复', async (t) => {
  const controller = new AbortController();
  let closed = false;
  t.mock.method(Completions.prototype, 'create', async () => ({
    controller,
    async *[Symbol.asyncIterator]() {
      try {
        yield {
          choices: [
            { index: 0, delta: { content: '第一段' }, finish_reason: null },
          ],
        };
        assert.fail('调用方停止后不能继续读取');
      } finally {
        closed = true;
      }
    },
  }));
  const history = createHistory();
  const outputs = runAgent('任务', {
    provider: new ZenMuxProvider('test', 'test'),
    history,
    maxModelCalls: 6,
    async execute() {
      assert.fail('不能执行工具');
    },
  });
  assert.equal(history.length, 1); // 创建生成器时尚未开始任务。
  for await (const output of outputs) {
    assert.deepEqual(output, { type: OUTPUT_TYPE.TEXT, text: '第一段' });
    break;
  }
  assert.equal(closed, true);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(
    history.map((message) => message.role),
    ['system', 'user'],
  );
});
