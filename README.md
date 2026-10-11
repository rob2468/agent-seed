# agent-seed · Agent 的第一粒种子

一个用于学习的最小 TypeScript Agent harness。第一里程碑只做一件事：**模型请求工具 → 执行只读工具 → 结果加入历史 → 再请求模型 → 回答**。

## 先运行，再读代码

需要 Node.js 22.9+、npm。默认 mock 不联网、不使用密钥，无需账户。

```sh
cd ~/Desktop/workspace/agent-seed
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run format:check
npm run typecheck
npm test
npm start -- "请读取 welcome.md 并介绍它"
```

依赖仅包含 npm 官方 registry 的 `openai`（官方 SDK）、`undici`（HTTP 请求与代理支持）、`typescript`、`@types/node` 和 `prettier`。锁文件固定实际安装版本。测试用 Node 自带测试器。

修改代码后运行 `npm run format` 统一排版；提交前用 `npm run format:check` 检查。项目采用 2 空格缩进、单引号和 80 列换行，保留教学注释。锁文件由 npm 管理，不手工格式化。

默认工作目录始终是本项目的 `demo/`，不会因为从别处启动而扫描电脑项目。内部执行流程如下（终端只显示交互提示、最终回答和错误）：

```text
历史 2 条 → list_directory(".") → 目录结果
历史 4 条 → read_file("welcome.md") → 文件文本
历史 6 条 → 最终回答
```

mock 是固定教学脚本，不理解任意自然语言任务；最终回答包含本次工具实际读取的文本。可以编辑 `demo/welcome.md` 再运行，观察答案随工具结果改变。

```sh
npm start -- --max-model-calls 2 "读文档"
# 会在两次模型请求后停止，退出码 2；正常回答为 0，执行错误为 1。
npm start -- --root ./demo --mode mock "读文档"
```

## 多轮对话

不带任务参数启动，会进入内存会话：

```sh
npm start -- --mode mock
# 或使用 .env 配置的模式
npm start
```

每输入一条任务，都会追加 user 消息，并运行一次 Agent Loop。后续请求携带之前的消息和工具结果；每个轮次（Turn）的模型调用次数（Model Call）独立计算。清空历史后，轮次从 1 重新开始。

- `/clear`：清空对话历史，保留初始 system 指令；不删除日志文件。
- `/exit`：退出。输入结束（EOF）也会退出；正在执行的任务会先完成。
- 空行忽略。会话仅在内存中保存，退出后丢失。

Mock 对每条任务重复“列目录 → 读文件 → 回答”的教学脚本，不理解自然语言追问；真实追问需要使用 ZenMux。达到模型调用次数上限后仍可输入下一条任务；模型请求或协议错误则沿用原来的行为，终止 CLI。当前没有自动裁剪历史或摘要。

带任务参数时仍只执行一次，适合脚本调用。

## 最值得先读的文件

1. `src/agent-loop.ts`：从 `history` 到 `provider.reply()`，再到 `execute()`，核心循环手写可读。
2. `src/providers/mock.ts`：不接模型也能看到三次模型调用的流程。
3. `src/tools.ts`：工具 schema、运行时参数校验、受限文件访问和错误结果。
4. `src/types.ts` 与 `src/providers/zenmux.ts`：直接使用 OpenAI SDK 消息类型和调用接口。
5. `test/agent.test.ts`：完整循环和失败路径如何验证。

历史最开始有 system 指令和 user 任务。模型每次返回一个 assistant 消息，它可能带多个工具调用。程序先保存这个消息，再逐个执行工具，将 `{ok,data}` 或 `{ok:false,error}` 序列化成 tool 消息，用 `tool_call_id` 对应模型的调用 ID。下一次请求携带完整历史，因此模型能根据观察继续决策。没有工具调用时返回最终答案；超过模型调用次数上限则主动结束，不额外请求模型。

`Provider` 表示模型接入模块，提供 `reply(history)`；`model` 专指请求中选择的模型名称。`src/providers/` 下分别实现 mock 和 ZenMux 服务接入，不增加注册中心或协议转换层。

消息统一使用 OpenAI SDK 的 `ChatCompletionMessageParam` 和 `ChatCompletionMessage`，mock 也遵循这一结构。工具调用直接读取 `tool_calls[].function.name` 和 `arguments`；真实模型返回的 `choice.message` 原样加入历史，不再转换成自定义消息模型。

工具失败也是观察，不会被当成成功文本。这里的调度只是一个顺序 `for` 循环。这里的 session 只是一次运行内的消息数组，进程退出即丢失。

## 与 DeepSeek Harness 对照学习

核对日期：2026-10-10；上游快照：`d743267388641bc76f17c45ce8b4c231aed1d32c`。以下是职责对照，不是复刻；本项目没有复制上游实现。

| 职责            | 本项目                                   | 上游阅读入口                                                                                                                                              | 暂未实现                           |
| --------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| agent-loop      | `runAgent()` 循环调用模型、观察、停止    | [agent.ts](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/agent.ts)           | 流式事件、复杂生命周期与取消恢复   |
| tool scheduling | `for...of` 顺序执行并按调用顺序回填      | [tool-calls.ts](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/tool-calls.ts) | 有界并行、独占屏障、取消时补齐结果 |
| provider        | `Provider` 接口 + mock / ZenMux provider | [llm](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm)                                         | 多 provider 注册、流式协议、重试层 |
| session         | 内存 `history`                           | [session](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/session)                            | 持久化、恢复、分支及事件投影       |

建议只对照这四个职责，先能手画一次工具循环。上游是插件化的大型项目，我们这一课没有插件、写工具、shell、多 Agent、数据库、队列或 Web UI。

## 真实模型

真实服务仅接入 ZenMux，通过 OpenAI SDK 调用其兼容的 Chat Completions API。用户自行设置 `ZENMUX_API_KEY` 和 `ZENMUX_MODEL`，选择支持 function calling 的可用模型。`npm start` 使用 Node 内置能力自动加载项目根目录的 `.env`，文件不存在时仍可启动；终端已有的同名环境变量优先。默认 mock 即使环境已有密钥也不会创建 SDK client。

首次配置时，在项目根目录复制示例文件，再用编辑器填写 `.env` 中需要的变量：

```sh
cp .env.example .env
```

`.env` 已被 Git 忽略；`.env.example` 只保留配置字段，不填写真实密钥。直接运行 `node dist/src/cli.js` 不会自动加载 `.env`，请使用 `npm start` 或自行添加 `--env-file-if-exists=.env`。

运行模式的优先级为：命令行 `--mode` > 环境变量 `AGENT_MODE` > `mock`。`AGENT_MODE` 未设置或为空时使用 mock，其他无效值会报错。在 `.env` 中设置 `AGENT_MODE=zenmux` 并填写 ZenMux 配置后，直接运行 `npm start` 即可调用真实模型；临时使用离线模式可运行 `npm start -- --mode mock`。

无秘密配置示例（仅展示变量名称，模型标识需自行填写）：

```text
ZENMUX_API_KEY=<由你自行安全设置，不要写进仓库>
ZENMUX_MODEL=<你账户可用且支持工具调用的模型标识>
```

完成自己的环境配置后才运行：

```sh
npm start -- --mode zenmux "列出目录，再读取 welcome.md 并总结"
```

此命令会发送任务、工具描述和读到的文件内容给 ZenMux，并可能产生费用。网络超时为 120 秒，终端区分显示请求超时、连接失败和接口错误（仅显示 HTTP 状态码，不输出 SDK 原始异常或认证头）。无自动重试，单次输出上限 2048 tokens。服务地址固定为 `https://zenmux.ai/api/v1`。

## 模型请求日志

ZenMux provider 将每次请求和响应的完整原始正文追加到项目根目录的 `logs/zenmux.log`，目录不存在时自动创建。时间采用运行机器的本地时区并保留毫秒和时区偏移，例如 `2026-10-11 22:30:00.123+08:00`。每段使用时间、请求 ID、`[turn=轮次]`、`[modelCall=本轮模型调用次数]` 和 `request` / `response` 标记，正文不解析、不重组、不截断；同一次请求与响应使用相同 ID、轮次和模型调用次数。这些信息只写在标签区，不加入请求或响应正文，终端不显示轮次及模型调用次数。响应通过副本读取，不影响 SDK 消费原响应。

只记录 HTTP 正文，不记录客户端配置、密钥或认证头。日志包含任务、历史消息、工具定义、工具结果以及模型返回的所有正文字段。HTTP 错误响应正文也会记录；网络连接失败且没有收到响应时，仅保留请求记录。mock 不写此日志。日志写入失败会使本次调用失败。

`logs/` 已加入 Git 忽略规则。日志持续追加，可自行删除文件清空；本地测试写入临时目录，不污染实际运行日志。

## 网络代理

真实请求使用 `undici` 的 `fetch` 和 `EnvHttpProxyAgent`，自动读取 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`（也支持小写，同名大小写同时存在时小写优先）。没有配置代理时直连；`NO_PROXY` 匹配的地址绕过代理。可通过终端或 `.env` 配置，例如 `HTTPS_PROXY=http://127.0.0.1:你的代理端口`。这里使用 HTTP/HTTPS 代理，不读取 `ALL_PROXY` 的 SOCKS 配置。

mock 不创建代理客户端；本地测试拦截 undici 调度，不建立网络连接。

## 第一版边界

- 仅允许相对路径，拒绝 `..`、绝对路径和空路径；解析真实路径后拒绝符号链接越界（含目录链接），允许仍位于根目录内的链接。
- 只读普通 UTF-8 文件，最多 16 KiB；实际读取也有硬上限，拒绝二进制解码错误。目录不递归，最多 100 项，返回 `truncated`。
- 默认最多 6 次模型请求，可设 1–20；单次模型响应最多 8 个工具调用。参数 JSON 和工具名均经过运行时校验。
- 文件访问错误变成清晰工具结果继续回传；模型连接或协议错误终止 CLI。

**这不是完整沙箱。** 路径检查到打开文件之间仍存在目录被并发替换的竞态；没有 OS 级隔离、硬链接来源检测、敏感文件识别或提示注入防护保证。只将自己信任的演示目录作为根，不要指向含秘密的项目，不要在恶意进程可同时修改的目录里运行。文件中的文字只作为数据，但模型是否遵守仍取决于模型。真实模式会把允许读取的内容发给 provider。

当前支持完整、受限的工具循环，以及仅保存在内存里的多轮会话。

## ZenMux 接入

`src/providers/zenmux.ts` 提供 `createZenMuxProvider()`，固定连接 ZenMux，直接使用 OpenAI SDK 消息类型。项目只支持 `mock` 和 `zenmux` 两种模式；未配置模式时使用 mock，通过 `--mode zenmux` 或 `AGENT_MODE=zenmux` 选择真实服务。

2026-10-10 核对的官方资料：

- [Quick Start](https://zenmux.ai/docs/guide/quickstart.html)：OpenAI SDK 的 `baseURL` 为 `https://zenmux.ai/api/v1`，实际 POST 路径是 `/chat/completions`，SDK 使用 `Authorization: Bearer` 认证。
- [Tool Calling](https://zenmux.ai/docs/guide/advanced/tool-calls.html)：支持 `tools`、assistant `tool_calls` 和 tool `tool_call_id` 回传。文档示例模型为 `moonshotai/kimi-k2`；这只是协议示例，并非替你选定模型。
- [Chat Completion API](https://zenmux.ai/docs/api/openai/create-chat-completion.html)：参数参考。
- [Models](https://zenmux.ai/models)：复制账户可用模型的完整 `provider/model-name` slug，确认支持 tool calling。

还需用户提供的非秘密信息：**完整模型 slug**，以及使用 PAYG 还是 Builder Plan（便于确认额度与模型权限）。模型名不自动猜测。首轮建议选择普通文本工具调用模型；当前直接回传模型的消息对象；provider 专有推理字段的兼容性尚未实测。

可在项目根目录的 `.env` 中填写 `AGENT_MODE=zenmux`、`ZENMUX_API_KEY` 和 `ZENMUX_MODEL`，然后通过 `npm start` 启动。不要把 Key 发到聊天、写入源码或命令行字面量。也可以继续在终端设置环境变量；macOS zsh 可使用下面的隐藏输入方式（不会显示 Key，也不把 Key 字面量写入 shell 历史；请勿开启 shell tracing）：

```sh
read -rs 'ZENMUX_API_KEY?请粘贴 ZenMux Key（隐藏输入）: '; echo
export ZENMUX_API_KEY
export ZENMUX_MODEL='替换为已确认的完整模型slug'
```

`npm start` 启动时加载 `.env`；程序只在显式选择真实模式时使用相应环境变量连接模型，不创建凭据，不查询账户。上面的终端设置仅影响当前终端及其子进程，其他终端或代理进程不会自动继承。准备好并确认要进行真实调用后运行：

```sh
npm start -- --mode zenmux --max-model-calls 3 "先列出目录，再读取 welcome.md，最后根据实际内容总结"
# 若使用终端环境变量，使用完毕可清除；这不会删除 .env 中的配置
unset ZENMUX_API_KEY
```

这次验证预计 3 次模型请求（列目录、读文件、回答），最多 3 次客户端请求，无 SDK 自动重试；模型也可能合并工具或提前回答，因此实际次数可能少于 3。若三次模型调用后仍未完成会以退出码 2 停止。费用或订阅额度按 ZenMux 实际模型与用量计算，模型调用次数上限不是金额保证。

本地测试使用 undici 的 MockAgent 拦截请求，验证目标 URL、测试用认证头、请求参数、工具结果历史与响应解析，不建立网络连接。

2026-10-11 已通过本地 HTTP 代理，使用 ZenMux 的 `deepseek/deepseek-v3.2` 完成真实验证：第 1 次模型调用列目录、第 2 次模型调用读取 `welcome.md`、第 3 次模型调用根据文件内容回答，进程退出码为 `0`。验证范围仅限本次环境和模型，不代表其他模型、账户或网络均可用；实际费用未核对。
