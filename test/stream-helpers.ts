import type {
  ChatCompletionMessage,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions';
import { runAgent, type AgentResult } from '../src/agent-loop.js';
import { readStream } from '../src/read-stream.js';
import { OUTPUT_TYPE } from '../src/types.js';

export function messageChunk(
  message: ChatCompletionMessage,
): ChatCompletionChunk {
  return {
    id: 'test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [
      {
        index: 0,
        finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop',
        delta: {
          role: 'assistant',
          content: message.content,
          refusal: message.refusal,
          tool_calls: message.tool_calls
            ?.filter((call) => call.type === 'function')
            .map((call, index) => ({ ...call, index })),
        },
      },
    ],
  };
}

export async function completeAgent(
  ...args: Parameters<typeof runAgent>
): Promise<AgentResult> {
  for await (const output of runAgent(...args)) {
    if (output.type === OUTPUT_TYPE.RESULT) {
      return output.result;
    }
  }
  throw new Error('缺少结果');
}

export async function completeReply(
  stream: AsyncIterable<ChatCompletionChunk>,
): Promise<ChatCompletionMessage> {
  for await (const output of readStream(stream)) {
    if (output.type === OUTPUT_TYPE.MESSAGE) {
      return output.message;
    }
  }
  throw new Error('缺少消息');
}
