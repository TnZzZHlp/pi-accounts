# pi-accounts

`pi-accounts` 是一个面向 [Pi coding agent](https://github.com/earendil-works/pi-mono) 的 ChatGPT Codex 多账号扩展。

它可以同时保存多个 `openai-codex` OAuth 登录，在当前账号的五小时或七天额度耗尽时自动切换，并在 Pi 底栏持续显示当前账号别名、剩余额度和最近一次重置倒计时。也可以用 `/accounts use <alias>` 手动指定下一次请求使用的账号。

## 功能

- 复用 Pi 自带的 ChatGPT Codex OAuth 登录和 token 刷新流程。
- 首次启动时自动导入 Pi 当前的 `openai-codex` 登录。
- 主动读取当前账号的订阅额度，额度耗尽时按账号顺序轮换。
- 请求收到 HTTP 429 或明确的 usage-limit 错误时，在尚未输出内容的前提下使用下一个账号无缝重试。
- 对 SSE、WebSocket 和 WebSocket 缓存传输都传入真正选中的 access token，避免复用旧账号连接。
- 底栏示例：`work · 4h 3m 72% · 3d 2h 41%`；每个窗口前的时间是对应额度的 reset 倒计时。
- `/accounts status` 显示当前 Codex 账号的完整额度、重置时间、reset credits 和本地账号标识。
- 使用 API key 的其他 GPT 模型会从 provider 响应中读取标准 `x-ratelimit-*` 请求及 Token 限额，并通过 `/accounts status` 显示。
- `/accounts` 不带参数会打开交互式 TUI，可直接查看、切换和管理账号。
- 使用文件锁和原子写入保护多进程下的账号文件及 Pi `auth.json`。

## 安装

从 GitHub 安装：

```bash
pi install git:github.com/TnZzZHlp/pi-accounts
```

也可以使用完整 HTTPS 地址：

```bash
pi install https://github.com/TnZzZHlp/pi-accounts
```

开发本地检出时，可以只为一次 Pi 会话加载：

```bash
pi -e /absolute/path/to/pi-accounts
```

安装后重新启动 Pi；已有交互会话可以运行 `/reload`。

如果此前安装过已合并进本项目的 `pi-gpt-quota-status`，请移除旧包以避免重复页脚：

```bash
pi remove git:github.com/TnZzZHlp/pi-gpt-quota-status
```

## 使用

当前 Pi 登录会在扩展启动时自动成为第一个托管账号。添加第二个账号：

```text
/accounts add personal
```

扩展会询问使用浏览器登录还是适合无头服务器的 device-code 登录。完成授权后，新账号会保存并设为当前账号。

直接打开交互式账号管理器：

```text
/accounts
```

使用方向键选择账号或操作，Enter 确认，Escape 返回。TUI 支持刷新额度、自动选择可用账号、添加或导入登录，以及对账号进行切换、重命名和确认删除。

也可以继续使用完整命令：

```text
/accounts tui
/accounts list
/accounts refresh
/accounts status
/accounts add [alias]
/accounts import [alias]
/accounts use <alias>
/accounts auto
/accounts rename <old> <new>
/accounts remove <alias>
```

- `/accounts use` 会立即把指定账号设为当前账号；如果它之后达到额度限制，自动故障转移仍然有效。
- `/accounts tui`、`/accounts menu` 和 `/accounts manage` 与不带参数的 `/accounts` 等价。
- `/accounts auto` 会刷新所有账号额度并选择一个可用账号。
- `/accounts refresh` 会刷新所有账号额度并列出账号状态。
- `/accounts remove` 会先确认，再删除该账号的本地 OAuth 凭据。删除最后一个账号时只移除 `auth.json` 中的 `openai-codex` 登录，不影响其他 provider。
- Codex 模型下的 `/accounts status` 会立即刷新额度并显示当前账号详情；其他 GPT 模型需要先发送一次请求，再用 `/accounts status` 查看 provider 返回的请求数和 Token 限额。

## 自动切换语义

每次 Codex agent run 开始前，扩展会检查当前账号的缓存额度。只要五小时或七天窗口中任意一个已经用完，就切换到下一个未受限账号。

上游额度状态可能在两次轮询之间变化，因此 provider 包装层还会处理实际请求错误。只有在该请求尚未产生文本、思考或工具调用输出时才会换号重试，防止将两个账号的部分响应拼在一起。如果所有账号都已用完或不可用，Pi 会收到最后一个真实 provider 错误。

## 数据与安全

账号数据默认存放在：

```text
~/.pi/agent/pi-accounts.json
```

如果设置了 `PI_CODING_AGENT_DIR`，则存放在该目录下。文件包含 OAuth access token 和 refresh token，权限为仅当前用户可读写，保护级别与 Pi 的 `auth.json` 相同。不要提交、复制或分享此文件。

扩展不会记录 token。额度请求只把所选账号的 access token 和 token 内的 ChatGPT account id 发送到 ChatGPT 的 usage endpoint。账号列表只显示别名和掩码后的邮箱；`/accounts status` 会在本地通知中显示当前账号的完整邮箱，与旧额度扩展的行为一致。

底层 usage endpoint 和 Pi provider 接口可能随上游版本变化。当前实现和测试基线是 Pi `0.84.4`。[OpenAI 官方文档](https://learn.chatgpt.com/docs/security/cli#sign-in)确认 ChatGPT 登录用于订阅访问，但并未把第三方多账号轮换描述为官方 Codex 功能；使用时应遵守适用于各账号的服务条款和组织策略。

## 开发与测试

```bash
npm install
npm test
```

测试覆盖交互式 TUI、Codex 与普通 GPT API 限额解析、`/accounts status`、页脚、凭据导入与同步、手动选择、账号删除、并发 OAuth token 刷新，以及 429 后换号重试。
