import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { ReadStream } from 'node:tty';

/**
 * 分离鼠标报告和键盘输入，避免滚轮、点击的控制序列进入文本框。
 */
export class WheelInput extends Transform {
  readonly isTTY = true;
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private pasting = false;
  private timer?: NodeJS.Timeout;
  private readonly source: ReadStream;

  constructor(source: ReadStream) {
    super();
    this.source = source;
  }

  /**
   * Ink 仍通过真实终端控制 raw mode。
   */
  setRawMode(enabled: boolean) {
    this.source.setRawMode(enabled);
    return this;
  }

  ref() {
    this.source.ref();
    return this;
  }

  unref() {
    this.source.unref();
    return this;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: TransformCallback,
  ) {
    clearTimeout(this.timer);
    this.pending += this.decoder.write(chunk);
    this.drainInput();
    // 单独的 Esc 不能一直等待后续字节，否则无法取消任务。
    if (this.pending && !this.pasting) {
      this.timer = setTimeout(() => {
        if (!this.pending.startsWith('\u001b[<')) {
          this.push(this.pending);
        }
        this.pending = '';
      }, 50);
    }
    done();
  }

  /**
   * 粘贴内容原样转交 Ink，只解析粘贴之外的 SGR 鼠标报告。
   */
  private drainInput() {
    const pasteStart = '\u001b[200~';
    const pasteEnd = '\u001b[201~';
    while (this.pending) {
      if (this.pasting) {
        const end = this.pending.indexOf(pasteEnd);
        if (end < 0) {
          const length = Math.max(0, this.pending.length - pasteEnd.length + 1);
          this.push(this.pending.slice(0, length));
          this.pending = this.pending.slice(length);
          return;
        }
        this.push(this.pending.slice(0, end + pasteEnd.length));
        this.pending = this.pending.slice(end + pasteEnd.length);
        this.pasting = false;
        continue;
      }

      const escape = this.pending.indexOf('\u001b');
      if (escape !== 0) {
        const length = escape < 0 ? this.pending.length : escape;
        this.push(this.pending.slice(0, length));
        this.pending = this.pending.slice(length);
        continue;
      }
      if (this.pending.startsWith(pasteStart)) {
        this.push(pasteStart);
        this.pending = this.pending.slice(pasteStart.length);
        this.pasting = true;
        continue;
      }
      const mouse = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.pending);
      if (mouse) {
        this.pending = this.pending.slice(mouse[0].length);
        const button = Number(mouse[1]) & ~(4 | 8 | 16);
        if (mouse[4] === 'M' && (button === 64 || button === 65)) {
          this.emit('wheel', button === 64 ? -3 : 3, Number(mouse[3]));
        }
        continue;
      }
      if (
        pasteStart.startsWith(this.pending) ||
        (this.pending.length < 64 && /^\u001b\[<[\d;]*$/.test(this.pending))
      ) {
        return;
      }
      this.push(this.pending[0]);
      this.pending = this.pending.slice(1);
    }
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void) {
    clearTimeout(this.timer);
    done(error);
  }
}
