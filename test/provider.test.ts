import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAI, ZENMUX_BASE_URL } from '../src/openai.js';
import { runAgent } from '../src/agent-loop.js';

// 所有响应都来自内存。此测试没有网络连接，也没有读取环境变量。
test('ZenMux SDK adapter 发送协议字段并将工具结果带到下一轮', async () => {
  const requests: Record<string, any>[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    assert.equal(String(input), `${ZENMUX_BASE_URL}/chat/completions`);
    assert.equal(
      new Headers(init?.headers).get('authorization'),
      'Bearer test-only-not-a-credential',
    );

    const body = JSON.parse(String(init?.body));
    requests.push(body);

    const first = requests.length === 1;
    return Response.json({
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
    });
  };

  const model = createOpenAI(
    'test-only-not-a-credential',
    'example/tool-model',
    { baseURL: ZENMUX_BASE_URL, fetch: fakeFetch },
  );

  const result = await runAgent(
    '读取文档',
    model,
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

test('ZenMux API 错误不自动重试', async () => {
  let calls = 0;

  const model = createOpenAI(
    'test-only-not-a-credential',
    'example/tool-model',
    {
      baseURL: ZENMUX_BASE_URL,
      fetch: async () => {
        calls++;
        return Response.json(
          { error: { message: 'offline simulated failure' } },
          { status: 503 },
        );
      },
    },
  );

  await assert.rejects(model.reply([{ role: 'user', content: 'test' }]));
  assert.equal(calls, 1);
});
