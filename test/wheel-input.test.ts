import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { ReadStream } from 'node:tty';
import { WheelInput } from '../prototype/wheel-input.js';

test('滚轮报告与键盘分离，忽略点击，支持拆分和连续报告', () => {
  const input = new WheelInput({} as ReadStream);
  const wheels: number[][] = [];
  input.on('wheel', (...event: number[]) => wheels.push(event));
  input.write('草稿\u001b[<64;10;');
  input.write('5M\u001b[<65;10;5M\u001b[<0;10;5M\u001b[<0;10;5m');
  input.write('\u001b[A\u001b[B\u001b[5~\u001b[6~\u001b[H\u001b[F');
  assert.deepEqual(wheels, [
    [-3, 5],
    [3, 5],
  ]);
  assert.equal(
    input.read().toString(),
    '草稿\u001b[A\u001b[B\u001b[5~\u001b[6~\u001b[H\u001b[F',
  );
  input.destroy();
});

test('粘贴中的控制序列和分段中文原样传递，不触发滚动', () => {
  const input = new WheelInput({} as ReadStream);
  input.on('wheel', () => assert.fail('粘贴不能触发滚动'));
  const text = '\u001b[200~中文\u001b[<64;10;5M\u001b[201~';
  for (const byte of Buffer.from(text)) {
    input.write(Buffer.from([byte]));
  }
  assert.equal(input.read().toString(), text);
  input.destroy();
});

test('单独 Esc 及时传递，残缺鼠标报告不进入输入框', async () => {
  const input = new WheelInput({} as ReadStream);
  input.write('\u001b');
  await delay(80);
  assert.equal(input.read().toString(), '\u001b');
  input.write('\u001b[<64;');
  await delay(80);
  assert.equal(input.read(), null);
  input.destroy();
});
