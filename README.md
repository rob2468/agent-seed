# agent-seed · Agent 的第一粒种子

一个用于学习的轻量 TypeScript Agent harness，核心流程是：**模型请求工具 → 执行工具 → 结果加入历史 → 再请求模型 → 回答**。当前支持受限的文件读写、多轮对话、本地会话恢复、手动与自动上下文压缩、任务取消和流式输出；写文件必须经过用户确认。

## 先运行，再读代码

需要 Node.js 22.9+、npm 和 ZenMux 账户。复制 `.env.example` 为 `.env`，填写 `AGENT_SEED_ZENMUX_API_KEY` 和 `ZENMUX_MODEL` 后启动。

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

默认工具工作目录是本项目的 `demo/`，可用 `--root` 指定其他目录。工具调用流程示例如下（实际调用由模型决定）；显式恢复会话后消息条数可能不同。终端显示启动信息、交互提示、回答和错误，ZenMux 对话正文逐段显示，写入前另行显示确认提示。

```text
历史 2 条 → list_directory(".") → 目录结果
历史 4 条 → read_file("welcome.md") → 文件文本
历史 6 条 → 最终回答
```

```sh
npm start -- --max-model-calls 2 "读文档"
# 达到两次模型调用上限时退出码为 2；正常回答为 0，执行错误为 1。
npm start -- --root ./demo "读文档"
```

## 多轮对话

不带任务参数启动，会进入新的交互会话；只有显式传入 `--resume` 才恢复历史：

```sh
npm start --
# 默认新建会话
npm start
```

每输入一条任务，都会追加 user 消息，并运行一次 Agent Loop。后续请求携带之前的消息和工具结果；每个轮次（Turn）的模型调用次数（Model Call）独立计算。清空历史后，轮次从 1 重新开始。

- `/compact`：手动调用模型生成摘要，保留 system 指令，保留最近一轮完整对话，只用摘要替换更早的历史，并重置上下文用量基准。摘要失败时保留原历史，可继续重试；没有更早历史时不调用模型。
- `/clear`：用当前代码的初始 system 指令重新开始，重置用量基准并保存；不删除日志文件。
- `/exit`：退出。输入结束（EOF）也会退出；正在执行的任务会先完成。
- 空行忽略。会话历史在每轮正常结束后保存，重启可恢复；详见“会话持久化”。

达到模型调用次数上限后仍可输入下一条任务。上下文预算错误会显示提示并保留交互会话，其他模型请求或协议错误会终止 CLI；手动压缩失败会保留原历史并回到输入提示。模型调用前预算不足时会尝试自动压缩，每轮最多一次。

带任务参数时只执行一轮任务，默认新建并保存会话，也可显式恢复，适合脚本调用。正常回答退出码为 0，执行错误为 1，达到模型调用次数上限为 2，取消为 130。

## 最值得先读的文件

1. `src/agent-loop.ts`：从 `history` 到 `provider.reply()`，再到 `execute()`，核心循环手写可读。
2. `src/read-stream.ts`：读取模型片段，拼接正文和工具调用。
3. `src/tools.ts`：工具 schema、运行时参数校验、受限文件访问和错误结果。
4. `src/types.ts` 与 `src/providers/zenmux.ts`：直接使用 OpenAI SDK 消息类型和调用接口。
5. `src/session.ts`：Session 管理历史、任务取消和终端交互；`src/session-store.ts` 负责保存与恢复。
6. `test/agent.test.ts`：完整循环和失败路径如何验证。

历史最开始有 system 指令和 user 任务。模型每次返回一个 assistant 消息，它可能带多个工具调用。程序先保存这个消息，再逐个执行工具，将 `{ok,data}` 或 `{ok:false,error}` 序列化成 tool 消息，用 `tool_call_id` 对应模型的调用 ID。下一次请求携带完整历史，因此模型能根据观察继续决策。没有工具调用时返回最终答案；超过模型调用次数上限则主动结束，不额外请求模型。

`Provider` 表示模型接入模块，通过 `reply(history, context, signal?)` 产出模型响应片段，并可提供 `summarize()` 和 `reset()`；`model` 专指请求中选择的模型名称。`src/providers/` 下实现 ZenMux 服务接入，不增加注册中心或协议转换层。

消息统一使用 OpenAI SDK 的 `ChatCompletionMessageParam` 和 `ChatCompletionMessage`。工具调用直接读取 `tool_calls[].function.name` 和 `arguments`。非流式请求直接使用返回的 `choice.message`；流式请求将正文、拒绝信息和工具调用增量拼接为同一消息类型，再加入历史。流式路径只保留这些已处理字段，不保证保留 provider 专有扩展字段。

工具失败也是观察，不会被当成成功文本。这里的调度只是一个顺序 `for` 循环。会话历史保存在本地，重启后可显式恢复。

## 与 DeepSeek Harness 对照学习

核对日期：2026-10-10；上游快照：`d743267388641bc76f17c45ce8b4c231aed1d32c`。以下是职责对照，不是复刻；本项目没有复制上游实现。

| 职责            | 本项目                                            | 上游阅读入口                                                                                                                                              | 暂未实现                           |
| --------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| agent-loop      | `runAgent()` 循环调用模型、执行工具、检查取消信号 | [agent.ts](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/agent.ts)           | 结构化流式事件、复杂生命周期       |
| tool scheduling | `for...of` 顺序执行并按调用顺序回填               | [tool-calls.ts](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/tool-calls.ts) | 有界并行、独占屏障、取消时补齐结果 |
| provider        | ZenMux、SSE 流式响应、预算检查与日志              | [llm](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm)                                         | 多 provider 注册、自动重试层       |
| session         | 多轮历史、JSON 持久化与恢复、压缩、取消时回退历史 | [session](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/session)                            | 分支、事件投影、并发保护           |

建议只对照这四个职责，先能手画一次工具循环。本项目没有插件、shell、多 Agent、数据库、队列或 Web UI。上游链接保留已核对的固定快照，本表的本项目一列按当前实现描述。

## 真实模型

真实服务仅接入 ZenMux，通过 OpenAI SDK 调用其兼容的 Chat Completions API。用户自行设置 `AGENT_SEED_ZENMUX_API_KEY` 和 `ZENMUX_MODEL`，选择支持 function calling 的可用模型。`npm start` 使用 Node 内置能力自动加载项目根目录的 `.env`，文件不存在时仍可启动；终端已有的同名环境变量优先。缺少密钥或模型配置时会提示错误。

首次配置时，在项目根目录复制示例文件，再用编辑器填写 `.env` 中需要的变量：

```sh
cp .env.example .env
```

`.env` 已被 Git 忽略；`.env.example` 只保留配置字段，不填写真实密钥。直接运行 `node dist/src/cli.js` 不会自动加载 `.env`，请使用 `npm start` 或自行添加 `--env-file-if-exists=.env`。

无秘密配置示例（仅展示变量名称，模型标识需自行填写）：

```text
AGENT_SEED_ZENMUX_API_KEY=<由你自行安全设置，不要写进仓库>
ZENMUX_MODEL=<你账户可用且支持工具调用的模型标识>
```

完成自己的环境配置后才运行：

```sh
npm start -- "列出目录，再读取 welcome.md 并总结"
```

此命令会发送任务、工具描述和读到的文件内容给 ZenMux，并可能产生费用。网络超时为 120 秒，终端区分显示请求超时、连接失败和接口错误（仅显示 HTTP 状态码，不输出 SDK 原始异常或认证头）。网络和接口错误不自动重试，单次输出上限默认 2048 tokens（可通过 `ZENMUX_MAX_OUTPUT_TOKENS` 配置）。服务地址固定为 `https://zenmux.ai/api/v1`。

## 上下文用量与预算

ZenMux 模式在模型调用前检查上下文预算，配置放在 `.env`：

```text
# 当前 DeepSeek V3.2 的窗口；更换模型时按服务商公布的规格调整。
ZENMUX_CONTEXT_WINDOW=128000
ZENMUX_MAX_OUTPUT_TOKENS=2048
```

输入预算 = 窗口上限 − 最大输出预留，默认 125952 tokens。输出预留同时用于请求中的 `max_completion_tokens`，需符合所选模型的输出限制；配置不能扩大服务端窗口。

每次模型调用前测量输入并预留输出空间：

```text
输入测量值 = 上次实际输入 + 上次实际输出 + 之后新增消息的估算
预算占用 = 输入测量值 + 本次最大输出预留
```

Provider 只保存两个值：上次服务端 `usage.total_tokens` 和对应的历史条数（包含上次助手回答）。上次回答已包含在实际输出中，不再重复估算；新增用户输入和工具结果按 JSON 字符数 / 4 向上取整，另加 4 token 的结构开销。缓存命中和推理用量是子项，不重复相加。

首次调用或缺失有效 `usage.total_tokens` 时，回退为完整消息与工具定义的字符数估算。`/clear` 显式重置上次用量和历史条数。为保持简单，历史支持追加、清空和上下文压缩，不检测其他中途改写或裁剪。服务端模板变化及字符估算可能带来误差，不能保证服务端接受。

预算占用达到窗口 80% 时提示，达到窗口上限时返回 `BUDGET_EXCEEDED`，不发送请求、不生成 request/response 日志，由 Agent Loop 显式决定压缩一次后重试。交互模式仍能用 `/clear` 清空后继续；单次任务以退出码 1 结束。服务端 HTTP 413 或 `context_length_exceeded` 仍作为超限兜底。

请求日志的预算相关标签只保留 `lastTotalTokens`（上次实际用量）和 `addedTokens`（新增消息估算量）。首次调用或缺失 usage 时，前者为 `unknown`，后者表示完整输入的估算量。窗口、输出预留等固定配置和可推导的结果不重复打印。响应不重复记录预算计算值。

响应日志的用量标签只保留服务端实际 `totalTokens`；缺失或无效时为 `unknown`。完整 usage 仍保留在原始响应正文中。原始请求和响应正文不变，真实 usage 用于更新下一次调用的基准。预算不足时自动压缩，不自动裁剪或切换模型。核心实现见 `src/context-budget.ts`。

## 模型请求日志

ZenMux provider 将每次请求和响应的原始正文追加到项目根目录的 `logs/zenmux.log`，目录不存在时自动创建。时间采用运行机器的本地时区并保留毫秒和时区偏移，例如 `2026-10-11 22:30:00.123+08:00`。每段使用时间、请求 ID、`[turn=轮次]`、`[modelCall=本轮模型调用次数]` 和 `request` / `response` 标记，同一次请求与响应使用相同 ID、轮次和模型调用次数。这些信息只写在标签区，不加入请求或响应正文，终端不显示轮次及模型调用次数。

非流式响应通过副本读取；流式响应在转交 SDK 的同时累计原始 SSE 正文，结束、取消或中断时记录已收到的内容。日志正文不重组、不主动截断，仅解析副本以提取用量标签。中断的流式响应可能只有部分正文。

只记录 HTTP 正文，不记录客户端配置、密钥或认证头。日志包含任务、历史消息、工具定义、工具结果以及模型返回的所有正文字段。HTTP 错误响应正文也会记录；网络连接失败且没有收到响应时，仅保留请求记录。日志写入失败会使本次调用失败。

`logs/` 已加入 Git 忽略规则。日志持续追加，可自行删除文件清空；本地测试写入临时目录，不污染实际运行日志。

## 网络代理

真实请求使用 `undici` 的 `fetch` 和 `EnvHttpProxyAgent`，自动读取 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`（也支持小写，同名大小写同时存在时小写优先）。没有配置代理时直连；`NO_PROXY` 匹配的地址绕过代理。可通过终端或 `.env` 配置，例如 `HTTPS_PROXY=http://127.0.0.1:你的代理端口`。这里使用 HTTP/HTTPS 代理，不读取 `ALL_PROXY` 的 SOCKS 配置。

本地测试拦截 undici 调度，不建立网络连接。

## 当前边界

- 仅允许相对路径，拒绝 `..`、绝对路径和空路径。读取和列目录在解析真实路径后拒绝符号链接越界，允许仍位于根目录内的链接；写入拒绝经过符号链接的目录以及符号链接或硬链接目标。
- 读取普通 UTF-8 文件，最多 16 KiB；实际读取也有硬上限，拒绝无效 UTF-8。写入经逐次确认后创建或完整覆盖 16 KiB 内的 UTF-8 文本，不创建父目录。目录不递归，最多 100 项，返回 `truncated`。
- 每轮默认最多 20 次模型请求，可设 1–20；单次模型响应最多 8 个工具调用。参数 JSON 和工具名均经过运行时校验。
- 文件访问错误和写入拒绝作为工具结果继续回传。上下文预算错误在交互模式中显示后可继续操作，其他模型连接或协议错误终止 CLI。
- 每个会话使用独立 JSON 文件，绑定工具工作目录，不隔离模型，不支持多个进程并发写同一会话。取消会回退历史，已经完成的文件写入不会撤销；覆盖写入不保证原子性。

**这不是完整沙箱。** 路径检查到打开文件之间仍存在目录被并发替换的竞态；没有 OS 级隔离、硬链接来源检测、敏感文件识别或提示注入防护保证。只将自己信任的演示目录作为根，不要指向含秘密的项目，不要在恶意进程可同时修改的目录里运行。文件中的文字只作为数据，但模型是否遵守仍取决于模型。真实模式会把允许读取的内容发给 provider。

## ZenMux 接入

`src/providers/zenmux.ts` 提供 `ZenMuxProvider` 类，通过 `new ZenMuxProvider(apiKey, model)` 创建实例，固定连接 ZenMux，直接使用 OpenAI SDK 消息类型。项目启动后直接使用 ZenMux，不再提供模式选择。

2026-10-10 核对的官方资料：

- [Quick Start](https://zenmux.ai/docs/guide/quickstart.html)：OpenAI SDK 的 `baseURL` 为 `https://zenmux.ai/api/v1`，实际 POST 路径是 `/chat/completions`，SDK 使用 `Authorization: Bearer` 认证。
- [Tool Calling](https://zenmux.ai/docs/guide/advanced/tool-calls.html)：支持 `tools`、assistant `tool_calls` 和 tool `tool_call_id` 回传。文档示例模型为 `moonshotai/kimi-k2`；这只是协议示例，并非替你选定模型。
- [Chat Completion API](https://zenmux.ai/docs/api/openai/create-chat-completion.html)：参数参考。
- [Models](https://zenmux.ai/models)：复制账户可用模型的完整 `provider/model-name` slug，确认支持 tool calling。

运行时必须配置账户可用的**完整模型 slug**，模型名不自动猜测；程序不读取或校验 PAYG / Builder Plan 类型。应选择支持工具调用的模型；流式路径仅拼接已处理的消息字段，provider 专有推理字段的兼容性尚未实测。

可在项目根目录的 `.env` 中填写 `AGENT_SEED_ZENMUX_API_KEY` 和 `ZENMUX_MODEL`，然后通过 `npm start` 启动。不要把 Key 发到聊天、写入源码或命令行字面量。也可以继续在终端设置环境变量；macOS zsh 可使用下面的隐藏输入方式（不会显示 Key，也不把 Key 字面量写入 shell 历史；请勿开启 shell tracing）：

```sh
read -rs 'AGENT_SEED_ZENMUX_API_KEY?请粘贴 ZenMux Key（隐藏输入）: '; echo
export AGENT_SEED_ZENMUX_API_KEY
export ZENMUX_MODEL='替换为已确认的完整模型slug'
```

`npm start` 启动时加载 `.env`；程序使用相应环境变量连接 ZenMux 模型，不创建凭据，不查询账户。上面的终端设置仅影响当前终端及其子进程，其他终端或代理进程不会自动继承。准备好并确认要进行真实调用后运行：

```sh
npm start -- --max-model-calls 3 "先列出目录，再读取 welcome.md，最后根据实际内容总结"
# 若使用终端环境变量，使用完毕可清除；这不会删除 .env 中的配置
unset AGENT_SEED_ZENMUX_API_KEY
```

这次验证预计 3 次模型请求（列目录、读文件、回答），最多 3 次客户端请求，无 SDK 自动重试；模型也可能合并工具或提前回答，因此实际次数可能少于 3。若三次模型调用后仍未完成会以退出码 2 停止。费用或订阅额度按 ZenMux 实际模型与用量计算，模型调用次数上限不是金额保证。

本地测试使用 undici 的 MockAgent 拦截请求，验证目标 URL、测试用认证头、请求参数、工具结果历史与响应解析，不建立网络连接。

2026-10-11 已通过本地 HTTP 代理，使用 ZenMux 的 `deepseek/deepseek-v3.2` 完成真实验证：第 1 次模型调用列目录、第 2 次模型调用读取 `welcome.md`、第 3 次模型调用根据文件内容回答，进程退出码为 `0`。验证范围仅限本次环境和模型，不代表其他模型、账户或网络均可用；实际费用未核对。

## 手动上下文压缩

`/compact` 总结用户目标、约束、已完成工作、关键结论和待办，不执行工具。原 system 指令和最近一轮完整对话保留，较早历史的摘要作为一条 user 消息放在两者之间。最近一轮从最后一条 user 消息开始，包含其后的全部工具请求、结果和回答；自动压缩时也保留当前尚在执行的这一轮。只有收到有效摘要后才替换会话历史并重置用量基准；下一次调用重新估算压缩后的完整输入。压缩后轮次按新历史中的 user 消息重新计算。

摘要请求也受上下文预算限制，建议在接近窗口上限时主动压缩；历史已过长时压缩也可能失败，此时可使用 `/clear`。摘要可能遗漏信息，不保证压缩后一定更短。原始摘要请求与响应同样写入日志。

## 会话持久化

默认每次启动新会话，生成独立 UUID，只包含初始 system 指令，不读取旧历史。所有会话统一保存在 `~/.agent-seed/sessions/<UUID>.json`，不按项目分目录。UUID 文件名就是会话 ID；启动时显示 ID、实际工作目录和新建或恢复状态。

```sh
# 默认新建；旧会话保留
npm start
npm start -- --root ./demo "读取 welcome.md"
# 恢复当前工作目录最近成功保存的会话
npm start -- --resume
npm start -- --root ./demo --resume -- "继续任务"
# 恢复指定 ID，使用其记录的工作目录（替换示例 UUID）
npm start -- --resume 11111111-1111-4111-8111-111111111111 -- "继续任务"
```

`--resume` 后紧跟的非选项参数作为会话 ID；带任务时必须用 `--` 分隔。指定 ID 时，如果同时显式传入 `--root` 且目录不一致，报错停止。默认工作目录仍是项目的 `demo/`。

会话文件保存 `{ "root": "真实工作目录的绝对路径", "history": [...] }`，不保存用量基准。工作目录通过 `realpath` 解析，同一目录的相对路径、绝对路径和符号链接视为相同目录。恢复后首次请求重新估算完整输入。

裸 `--resume` 暂时扫描所有 UUID 会话文件，按 `root` 筛选，再按文件修改时间选择最近保存的一份；时间相同取 ID 字典序较大者。损坏或不可读取的候选文件提示后跳过；没有匹配会话时报错。指定 ID 则直接读取对应文件，要求小写 UUID，不能传文件路径。文件损坏、目标不存在或工作目录不可访问时，报错停止，不自动改为新会话。本次没有索引、数据库、会话列表或删除功能。

每轮正常结束（包括达到模型调用次数上限）、`/compact` 成功和 `/clear` 后保存。新会话首次保存前不创建文件；恢复后继续更新同一 ID 的文件。`/clear` 清空历史但保留 ID，`/compact` 更新当前会话。取消或失败不保存本轮，磁盘文件保持原样。保存先写临时文件，再重命名替换原文件；保存失败明确报错。

原项目内的 `.agent-seed/session.json` 保留不动，不自动迁移或恢复。不同新会话互不覆盖；暂不支持多个进程同时修改同一会话。

## 取消任务

交互模式执行任务或 `/compact` 时，按 `Ctrl+C` 取消并回到输入提示。模型请求通过取消信号终止；工具执行期间会等当前工具返回，再停止后续工具和模型调用。

取消后恢复操作开始前的历史，重置上下文用量基准，不更新会话文件。已经完成的文件写入不会随历史回退而撤销。已写入的请求日志保留；尚未收到 HTTP 响应时不补写响应日志，已开始的流式响应会记录已收到的部分。

空闲时按 `Ctrl+C` 退出。带任务参数的单次运行被取消后，以退出码 130 结束。

## 写文件与确认

`write_file` 接收 `path` 和 `content`，写入前展示相对工作目录的路径、完整内容和是否覆盖。只有输入 `y` 或 `yes` 才执行；其他输入、输入结束或没有确认能力时均拒绝。拒绝作为工具结果返回模型。确认答案不会进入对话历史。

支持创建和完整覆盖 16 KiB 内的 UTF-8 文本文件，父目录必须存在。不允许绝对路径、路径穿越、符号链接、硬链接或非普通文件。确认期间目标发生变化时停止写入，需重新确认。暂不提供权限记忆、批量授权或自动创建目录。

交互模式与单次任务都支持确认。等待确认时按 `Ctrl+C` 会取消当前任务；已开始的文件写入会执行完，不自动撤销。可以输入“将你好写入 hello.txt”来尝试。已有会话若保留了旧版只读 system 指令，先使用 `/clear` 开始新会话。

## 流式输出

ZenMux 对话在终端逐段显示正文；工具调用的名称和参数按索引拼接，响应完整结束后再执行，写入仍需用户确认。摘要请求保持非流式。

Ctrl+C 会中止当前请求并恢复本轮开始前的历史；已显示的片段不会保存到会话中，已经执行的文件写入不会撤销。日志保留原始 SSE 响应正文，取消或中断时记录已收到的部分。用量基准使用服务端最后返回的 usage，缺失时回退到估算。

流式调用链使用异步生成器：Provider 产出 OpenAI SDK 片段，`read-stream.ts` 拼接正文和工具参数，Agent Loop 产出正文增量与最终结果，Session 通过 `for await...of` 显示和保存。不传递正文回调；写入确认仍在工具初始化时绑定一次。`providers/logged-fetch.ts` 独立负责原始请求与响应日志。

## 自动上下文压缩

每次模型调用前，本地预算不足时复用 `/compact` 的摘要逻辑，每轮任务最多尝试一次。上一批工具调用及其结果全部收齐后才会进入下一次预算检查。摘要成功后保留 system 指令，保留最近一轮完整对话，只用摘要替换更早的历史，重置用量基准，再检查预算并继续当前模型调用；被预算拦截的尝试不占模型调用次数。

没有可压缩的旧历史时直接停止，不请求摘要。摘要失败保留压缩前历史并停止本轮；压缩后仍不足也停止，不反复压缩。服务端上下文错误、网络错误和接口错误不触发自动压缩。摘要请求本身仍受预算限制，历史过长时压缩也可能失败。

自动压缩后的历史随本轮正常结束一起保存。压缩期间或压缩成功后继续执行时按 Ctrl+C，都恢复本轮开始前的历史并重置用量基准，不更新会话文件；已经完成的文件写入不会撤销。

预期结果使用常量状态表达：本地预算不足返回 `BUDGET_EXCEEDED`，用户取消返回 `CANCELLED`，模型超时、连接或接口失败返回 `FAILED` 并保留原因。Agent Loop 显式选择压缩、停止或继续，最终结果注明模型调用或压缩阶段；Session 按结果决定回滚、提示和保存。SDK 的请求异常只在 Provider 边界转换，未预期的程序错误继续抛出。取消信号仍传给底层请求和工具，用于中止正在等待的操作。
