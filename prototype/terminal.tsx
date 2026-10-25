import { setTimeout as delay } from 'node:timers/promises';
import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Text,
  render,
  useApp,
  useInput,
  useBoxMetrics,
  useWindowSize,
  type DOMElement,
} from 'ink';
import TextInput from 'ink-text-input';
import { WheelInput } from './wheel-input.js';

/**
 * 已完成的展示内容，保留在应用内的对话记录中。
 */
interface Entry {
  /**
   * 展示条目的唯一编号。
   */
  id: number;
  /**
   * 区分用户输入、助手回答和操作提示。
   */
  role: 'user' | 'assistant' | 'notice';
  /**
   * 显示的完整文本。
   */
  text: string;
}

/**
 * 模拟写入的确认答案，只影响界面，不写文件。
 */
type Confirm = (approved: boolean) => void;

const sampleFile = 'notes/demo.md';
const sampleContent =
  '# 下一步\n\n- 完成终端 UI 原型\n- 验证中文输入与流式显示\n- 确认效果后再接入 Agent';

/**
 * 用固定数据体验对话、流式回答、执行状态和写入确认。
 */
function TerminalDemo({ keyboard }: { keyboard: WheelInput }) {
  const { exit } = useApp();
  const { columns: width, rows: height } = useWindowSize();
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const viewport = useBoxMetrics(viewportRef);
  const content = useBoxMetrics(contentRef);
  // null 表示跟随最新内容；数字表示用户正在查看历史的位置。
  const [scrollPosition, setScrollPosition] = useState<number | null>(null);
  const maxScroll = Math.max(0, content.height - viewport.clientHeight);
  const scrollTop =
    scrollPosition === null ? maxScroll : Math.min(scrollPosition, maxScroll);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [answer, setAnswer] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [frame, setFrame] = useState(0);
  const sequence = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const confirmation = useRef<Confirm | undefined>(undefined);

  useEffect(() => {
    // 直接接收鼠标报告，关闭滚轮转方向键，避免与真实键盘混淆。
    process.stdout.write(
      '\u001b[?1000;1006;1007s\u001b[?1007l\u001b[?1000;1006h',
    );
    return () => {
      process.stdout.write('\u001b[?1000;1006;1007r');
      controller.current?.abort();
      confirmation.current?.(false);
    };
  }, []);

  useEffect(() => {
    const scroll = (distance: number, row: number) => {
      // 标题占两行，底部占六行；鼠标位于对话区时才滚动。
      if (row <= 2 || row > height - 6) {
        return;
      }
      setScrollPosition((previous) => {
        const current =
          previous === null ? maxScroll : Math.min(previous, maxScroll);
        const next = Math.max(0, Math.min(maxScroll, current + distance));
        return next === maxScroll ? null : next;
      });
    };
    keyboard.on('wheel', scroll);
    return () => {
      keyboard.off('wheel', scroll);
    };
  }, [keyboard, height, maxScroll]);

  useEffect(() => {
    if (!busy || confirming) {
      return;
    }
    const timer = setInterval(() => setFrame((value) => value + 1), 120);
    return () => clearInterval(timer);
  }, [busy, confirming]);

  function append(role: Entry['role'], text: string) {
    const entry = { id: sequence.current++, role, text };
    setEntries((previous) => [...previous, entry]);
  }

  function cancel() {
    controller.current?.abort();
    confirmation.current?.(false);
    confirmation.current = undefined;
    setConfirming(false);
  }

  useInput((text, key) => {
    if (key.ctrl && text === 'c') {
      if (controller.current) {
        cancel();
      } else {
        exit();
      }
      return;
    }
    if (key.escape && controller.current) {
      cancel();
      return;
    }
    if (confirming) {
      if (text.toLowerCase() === 'y') {
        confirmation.current?.(true);
      } else if (text.toLowerCase() === 'n' || key.return) {
        confirmation.current?.(false);
      } else {
        return;
      }
      confirmation.current = undefined;
      setConfirming(false);
    }
  });

  async function submit(value: string) {
    const task = value.trim();
    if (!task || controller.current) {
      return;
    }
    setInput('');
    setScrollPosition(null);
    if (task === '/exit') {
      exit();
      return;
    }
    if (task === '/clear') {
      append(
        'notice',
        '模拟上下文已清空；屏幕历史保留。原型不保存或恢复会话。',
      );
      return;
    }
    if (
      task.startsWith('/') &&
      !['/write', '/compact', '/fail'].includes(task)
    ) {
      append(
        'notice',
        '可用命令：/write 写入确认 · /compact 压缩 · /fail 失败 · /clear 清空 · /exit 退出',
      );
      return;
    }

    append('user', task);
    const operation = new AbortController();
    controller.current = operation;
    const signal = operation.signal;
    setBusy(true);
    setAnswer('');
    let response = '';
    try {
      if (task === '/compact') {
        setStatus('正在整理较早的对话');
        await delay(1500, undefined, { signal });
        response =
          '模拟压缩完成。最近一轮对话保持完整，较早的内容已整理为摘要。';
      } else if (task === '/write' || /写入|写文件/.test(task)) {
        setStatus('正在准备写入内容');
        await delay(600, undefined, { signal });
        setStatus('等待你的确认');
        const approved = await new Promise<boolean>((resolve) => {
          confirmation.current = resolve;
          setConfirming(true);
        });
        signal.throwIfAborted();
        if (approved) {
          setStatus(`正在模拟写入 ${sampleFile}`);
          await delay(700, undefined, { signal });
          response = `已演示写入 ${sampleFile} 的确认流程。\n\n这是 UI 原型，磁盘上的文件没有发生变化。`;
        } else {
          response = '已拒绝这次写入，文件未修改。你可以继续输入其他任务。';
        }
      } else if (task === '/fail') {
        setStatus('正在模拟读取 missing.md');
        await delay(1000, undefined, { signal });
        append('notice', '读取失败：文件不存在（模拟）。请检查路径后重试。');
        return;
      } else {
        setStatus('正在模拟读取 welcome.md');
        await delay(1200, undefined, { signal });
        response =
          '已完成模拟读取。\n\nagent-seed 是一个用于学习的 TypeScript Agent：接收任务、调用工具、读取结果，再生成回答。\n\n这个原型把对话、执行状态、输入和确认放在同一套界面中。较长的文本会根据终端宽度换行，已经完成的内容保留在应用内，可以用鼠标滚轮查看。\n\n输入 /write 可以体验写入确认，输入 /compact 可以体验压缩提示。';
      }

      setStatus('正在生成回答');
      let rendered = '';
      for (const character of response) {
        await delay(20, undefined, { signal });
        rendered += character;
        setAnswer(rendered);
      }
      append('assistant', response);
    } catch (error) {
      if (signal.aborted) {
        append('notice', '任务已取消。可以继续输入；本次未完成的回答不保留。');
      } else {
        append(
          'notice',
          `演示失败：${error instanceof Error ? error.message : '未知错误'}`,
        );
      }
    } finally {
      controller.current = undefined;
      confirmation.current = undefined;
      setConfirming(false);
      setAnswer('');
      setStatus('');
      setBusy(false);
    }
  }

  const contentWidth = Math.max(1, width);
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][
    frame % 10
  ];

  return (
    <Box
      flexDirection="column"
      width={contentWidth}
      height={height}
      overflow="hidden"
    >
      <Box flexDirection="column" height={2} flexShrink={0}>
        <Text bold color="cyan" wrap="truncate">
          agent-seed <Text color="gray">/ terminal preview</Text>
        </Text>
        <Text dimColor wrap="truncate">
          模拟演示 · 不调用模型 · 不读写文件
        </Text>
      </Box>
      <Box
        ref={viewportRef}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        overflow="hidden"
        contentOffsetY={scrollTop}
        flexDirection="column"
      >
        <Box ref={contentRef} flexDirection="column" flexShrink={0}>
          {entries.length === 0 && (
            <Text dimColor>
              输入任意任务开始，或使用 /write、/compact、/fail。
            </Text>
          )}
          {entries.map((entry) => (
            <Box
              key={entry.id}
              marginBottom={1}
              flexShrink={0}
              paddingX={1}
              paddingY={entry.role === 'user' ? 1 : 0}
              backgroundColor={entry.role === 'user' ? '#262626' : undefined}
            >
              <Box width={2} flexShrink={0}>
                <Text color={entry.role === 'notice' ? 'yellow' : 'gray'}>
                  {entry.role === 'user'
                    ? '›'
                    : entry.role === 'notice'
                      ? '!'
                      : '•'}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text
                  color={
                    entry.role === 'notice'
                      ? 'yellow'
                      : entry.role === 'user'
                        ? '#d0d0d0'
                        : undefined
                  }
                >
                  {entry.text}
                </Text>
              </Box>
            </Box>
          ))}
          {answer && (
            <Box marginBottom={1} flexShrink={0} paddingX={1}>
              <Box width={2} flexShrink={0}>
                <Text color="gray">•</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text>{answer}</Text>
              </Box>
            </Box>
          )}
          {confirming && (
            <Box
              flexDirection="column"
              flexShrink={0}
              borderStyle="round"
              borderColor="yellow"
              paddingX={1}
            >
              <Text bold color="yellow">
                允许这次写入？
              </Text>
              <Text>{sampleFile} · 模拟创建</Text>
              <Box marginY={1}>
                <Text>{sampleContent}</Text>
              </Box>
              <Text>
                <Text bold color="green">
                  Y
                </Text>{' '}
                允许 · <Text bold>N / Enter</Text> 拒绝 · Esc 取消任务
              </Text>
            </Box>
          )}
        </Box>
      </Box>
      <Box height={1} flexShrink={0}>
        <Text dimColor wrap="truncate">
          鼠标滚轮查看对话 · 滚到底部继续跟随
          {scrollPosition !== null ? ' · 查看历史中' : ''}
        </Text>
      </Box>
      <Box height={1} flexShrink={0}>
        <Text color={busy ? 'cyan' : 'gray'} wrap="truncate">
          {busy ? `${spinner} ${status}` : '就绪'}
        </Text>
      </Box>
      <Box
        height={3}
        flexShrink={0}
        overflow="hidden"
        backgroundColor="#202020"
        paddingX={1}
        paddingY={1}
      >
        <Text color="gray">› </Text>
        {busy ? (
          <Text dimColor>任务进行中…</Text>
        ) : (
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={(value) => {
              void submit(value);
            }}
            placeholder="输入任务或 /help"
          />
        )}
      </Box>
      <Box height={1} flexShrink={0}>
        <Text dimColor wrap="truncate">
          {confirming
            ? 'Y 允许 · N / Enter 拒绝 · Esc / Ctrl+C 取消'
            : busy
              ? 'Esc / Ctrl+C 取消当前任务'
              : 'Enter 发送 · /clear 清空 · /exit 或 Ctrl+C 退出'}
        </Text>
      </Box>
    </Box>
  );
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error(
    '终端 UI 原型需要交互式终端，请直接运行 npm run ui:demo。原有 CLI 仍支持纯文本与管道。',
  );
  process.exitCode = 1;
} else {
  const keyboard = new WheelInput(process.stdin);
  const app = render(<TerminalDemo keyboard={keyboard} />, {
    stdin: keyboard,
    exitOnCtrlC: false,
    alternateScreen: true,
  });
  process.stdin.pipe(keyboard);
  try {
    await app.waitUntilExit();
  } finally {
    process.stdin.unpipe(keyboard);
    keyboard.destroy();
  }
}
