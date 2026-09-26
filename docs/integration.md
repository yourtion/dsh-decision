# 接入与验证

本仓库把同一套 Jev 判断用于两个宿主：pi 监听 `tool_call`，dsh 使用自身的 waterfall 扩展点。pi 目前只判断**调用工具前**的风险；dsh 另有路由、结果 judge、机器审批切面。两边的默认执行模式都是 `shadow`。

示例命令要求 Node.js 22.19+ 和 pnpm。若本机没有独立的 `pnpm` 命令，可用 `npm exec --yes --package=pnpm@10.17.1 -- pnpm <命令>` 执行相同操作；这也是本机检查时使用的 pnpm 版本。

## 先区分两种凭证

| 用途                              | 配置位置                     | 当前默认                                                                                            |
| --------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| Jev 判断工具风险                  | pi 扩展或 dsh 的 Jev adapter | Vercel AI Gateway key，`https://ai-gateway.vercel.sh/typesafe/v1/systemone`，模型 `typesafe-ai/jev` |
| pi 的主模型生成回复和发出工具调用 | pi 自身的模型与认证配置      | 由 `--provider` / `--model` 或 pi 设置选择                                                          |

Vercel Gateway 的 [TypeSafe 兼容 API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)接受 Gateway key，并保留本仓库 Jev adapter 使用的 `noul` 等请求与响应字段。Vercel key 不能配着 `jev-ai.pro` 的 URL 使用。pi 扩展的 Gateway 模式优先读取 `AI_GATEWAY_API_KEY`，其次读取 `JEV_API_KEY`；dsh 示例 profile 的 `apiKeyEnv` 固定为 `AI_GATEWAY_API_KEY`。

本地启动进程必须能读到 key。只在 Vercel 项目设置中保存变量，不会自动注入本机 pi 或 dsh。把 key 放在交互式 shell 配置时，也要确认运行 pi 的那个 shell 已加载配置；脚本、CI 或非交互式 shell 可能不会读取 `.bashrc`。下面只检查变量是否存在，不显示值：

```sh
if [ -n "${AI_GATEWAY_API_KEY:-}${JEV_API_KEY:-}" ]; then
  echo 'Jev key present'
else
  echo 'Jev key missing'
fi
```

## pi 接入

1. 安装仓库依赖并构建：

   ```sh
   pnpm install
   pnpm run build
   ```

2. 在同一个 shell 中确认 Gateway key 已导出。扩展在加载时检查 key；缺失会直接报错。pi 自身的主模型还需要单独可用的凭证，可检查所选 provider：

   ```sh
   pi auth check --provider zai-coding-cn --no-refresh
   ```

   `zai-coding-cn` 是本次冒烟所用的示例。若你的主模型走 `vercel-ai-gateway`，请检查该 provider；仅设置兼容扩展的 `JEV_API_KEY` 不会自动让 pi 主模型读取它。

3. 从**仓库根目录**临时加载扩展并触发一次只读工具调用：

   ```sh
   pi -e ./packages/pi-decision --no-extensions --no-session \
     --no-context-files --no-skills --no-prompt-templates \
     --tools read --provider zai-coding-cn --model glm-5.3-flash \
     --thinking off --print \
     'Use the read tool exactly once to read README.md, then reply with only its first Markdown heading. Do not use any other tool.'
   ```

   `--provider` 和 `--model` 要改成你的可用主模型。`--tools read` 限制本次冒烟只能读取；`--no-session` 不保存对话；`--no-extensions` 禁用自动发现的扩展，但仍加载显式传给 `-e` 的扩展。若要查看 pi 事件流，可追加 `--mode json`。

4. 临时加载验证后，可运行 `pi install ./packages/pi-decision` 持久加载。安装的是仓库中的本地包；保留这个仓库和 `pnpm install` 创建的 workspace 依赖链接。运行 `pi list` 可查看已安装的扩展。

### pi 配置与行为

| 环境变量                             | 默认             | 作用                                                                   |
| ------------------------------------ | ---------------- | ---------------------------------------------------------------------- |
| `AI_GATEWAY_API_KEY` / `JEV_API_KEY` | 无               | Vercel Gateway key；同时存在时优先前者                                 |
| `PI_DECISION_JEV_BACKEND`            | `vercel`         | `vercel` 使用 Gateway；`direct` 使用 `jev-ai.pro` 和 `JEV_API_KEY`     |
| `PI_DECISION_ENFORCEMENT`            | `shadow`         | `shadow` 异步观察；`enforce` 等待判断并应用结果（实验特性）            |
| `PI_DECISION_TOOLS`                  | 空，表示所有工具 | 逗号分隔的准确工具名，如 `bash,write`                                  |
| `PI_DECISION_ON_FAILURE`             | `allow`          | Jev 请求或响应失败时的策略：`allow`、`ask`、`deny`                     |
| `PI_DECISION_OUTBOUND`               | `redact`         | 出站脱敏：`redact` 掩码密钥形态内容；`raw` 原样发送                    |
| `PI_DECISION_AUDIT`                  | `on`             | 审计 trace 开关：`on`、`off`                                           |
| `PI_DECISION_AUDIT_PATH`             | XDG state 目录   | 审计 JSONL 文件路径，默认 `~/.local/state/dsh-decision/pi-audit.jsonl` |

在 `shadow` 中，工具立即继续；只有 `review`、`deny` 或请求失败会写 stderr 日志，`allow` 不输出判定日志。在 `enforce` 中，`allow` 继续，`deny` 阻断，`review` 也阻断并提示人工复核，因为 pi 没有可移交的审批链。失败策略中的 `ask` 同样映射为阻断。`PI_DECISION_ON_FAILURE` 不影响缺 key 的加载错误。

**`enforce` 是实验特性。** 默认阈值来自 2026-09-26 的一次 live 评估（22 个标注用例，见[阈值评估](#阈值评估)），样本量小、未做跨日稳定性验证；enforce 启动时扩展会向 stderr 打一条警告。每次判定（shadow 和 enforce 都）会写一条 sanitized 审计记录到 `PI_DECISION_AUDIT_PATH`，内容只有判定、概率、policyVersion、脱敏计数和粗粒度错误类别，不含工具参数原文。

2026-09-26 的完整 pi 冒烟（pi 0.87.1、`zai-coding-cn/glm-5.3-flash` 主模型）：模型调用一次 `read README.md`，工具成功返回，最终回复 `# @techs/dsh-decision`。Jev shadow 给出的 `secretExposure` 概率为 0.19/0.18——这正是重校前的旧阈值（复核线 0.15）下的典型只读误报；重校后该类调用按默认阈值放行。pi 包当前没有环境变量形式的阈值配置，需要覆盖时在 dsh 侧或代码内配置。

### pi 常见问题

- **扩展加载时报缺 key**：检查 `AI_GATEWAY_API_KEY` 或 `JEV_API_KEY` 是否已导出到启动 pi 的进程。不要通过打印 key 本身排查。
- **主模型报 credentials not configured**：这是 pi 主模型的认证问题。用 `pi auth check --provider <provider> --no-refresh` 检查，并明确选择有凭证的模型；Jev 的 `JEV_API_KEY` 不会自动注册为 pi 主模型凭证。
- **看不到 shadow 日志**：`allow` 不记判定日志；需要确认工具确实被调用。日志写 stderr，pi 的 JSON/print 输出写 stdout。
- **Gateway 返回 401 或模型错误**：核对 key、base URL 和模型是否同属一个接入路径。Gateway 默认是 `https://ai-gateway.vercel.sh/typesafe` + `typesafe-ai/jev`；直连是 `https://jev-ai.pro/api` + `jev-latest`。

## dsh 接入

示例 [profile](../profile/cordis.patch.yml) 使用 Gateway。它只读取 `AI_GATEWAY_API_KEY`；如果现有 Gateway key 存在于 `JEV_API_KEY`，在启动 dsh 的 shell 中先运行 `export AI_GATEWAY_API_KEY="$JEV_API_KEY"`，或者把 profile 中的 `apiKeyEnv` 改为 `JEV_API_KEY`。

```sh
pnpm install && pnpm run build
mkdir -p ~/.dsh/profiles
ln -s "$(pwd)/profile" ~/.dsh/profiles/decision
(cd profile && pnpm install)
dsh --profile decision '列出本目录文件并统计行数'
```

从仓库根目录执行这些命令。若 `~/.dsh/profiles/decision` 已存在，检查它是否指向本仓库的 `profile/`，无需重复创建软链。dsh profile 中 `permission: machine` 与 `enforcement: shadow` 同时存在；shadow 下原生 dsh 决策链继续生效。切到 `enforce` 前应先观察误判。

| 切面           | dsh 事件             | 核心默认 | 此 profile                 |
| -------------- | -------------------- | -------- | -------------------------- |
| 工具 guardrail | `tools/pre-execute`  | 开       | 开                         |
| 模型路由       | `agent/request`      | 关       | 关                         |
| 工具结果 judge | `tools/post-execute` | 关       | 关                         |
| 机器审批       | `approval/request`   | 关       | `permission: machine` 启用 |

`permission`（`native | machine`）与 `enforcement`（`shadow | enforce`）分别控制审批接管和策略是否生效。dsh 的 Auto 与 Full Access 仍由原生权限预设管理。Guardrail 和 Judge 若在 enforce 下启用，仍可能限制原生 Full Access。`review` 在 dsh 中移交原生人工审批；Jev provider 当前没有与审批策略对应的校准资格，所以不会自动批准。

常用配置改在 [profile](../profile/cordis.patch.yml) 的 `decision.config` 中，例如：

```yaml
enforcement: shadow # 实验特性：enforce 前先观察误报（启动时会再打一次警告）
privacy:
  outbound: redact # redact 掩码密钥形态内容后发送；raw 原样发送
audit:
  enabled: true # sanitized 判定审计，默认写 XDG state 目录
  # path: /var/log/dsh-decision-audit.jsonl
guardrail:
  enabled: true
  onFailure: allow # Jev 请求失败时 allow | ask | deny
  # risks: # 省略时使用重校后的内置默认（2026-09-26 评估得出）
  #   secretExposure: { reviewAt: 0.55, denyAt: 0.85 }
  #   destructive: { reviewAt: 0.45, denyAt: 0.55 }
routing: { enabled: false } # 启用时需自行配置可选 provider/model
judge: { enabled: false, blockAt: 0.75 }
machine: { uncertain: human } # human | deny
```

若改用直连 Jev key，在 [profile](../profile/cordis.patch.yml) 的 `decision-jev.config` 中设置：

```yaml
apiKeyEnv: JEV_API_KEY
baseUrl: https://jev-ai.pro/api
model: jev-latest
```

### 现有 Web profile

独立的 `decision` profile 使用 headless bundle；已有的 dsh Web 进程使用 `web` profile，两者需要分别加载插件。从仓库根目录安装本地包：

```sh
dsh plugin --profile web add "file:$(pwd)/packages/decision" "file:$(pwd)/packages/decision-jev"
```

再把 [示例 patch](../profile/cordis.patch.yml) 中的 `decision` 和 `decision-jev` 两项并入 `~/.dsh/profiles/web/cordis.patch.yml`，保留原有配置，重启 Web 进程。Web profile 使用的 `AI_GATEWAY_API_KEY` 必须对启动 dsh 的进程可见；本机将其放在权限为 600 的 `~/.dsh/.env`。只安装包而没有启用 patch 时，Web 中不会加载 decision。

### 验证范围（2026-09-26）

| 路径             | 已验证                                                                                                            | 尚未做端到端验证              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 独立 dsh profile | `glm-5.3-flash` 真实工具调用；shadow 下工具继续执行；临时 enforce patch 触发 guardrail 拒绝，session 日志记录原因 | 路由、结果 judge、人工审批 UI |
| dsh Web profile  | 插件进入配置并成功启动本地 HTTP 服务；未认证请求返回 401                                                          | 浏览器对话触发工具和审批      |
| Jev Gateway      | 真实请求返回有效判断；guardrail 一次请求取得六维答案                                                              | 阈值校准与长期误判率          |
| pi 扩展          | Flash 主模型调用只读工具，Jev shadow 完成判断；enforce 的 allow/review/deny 和失败策略有自动化测试                | 真实交互中的人工复核体验      |

`pnpm run typecheck`、`pnpm run test`（70 个测试）、`pnpm run lint` 和 `pnpm run fmt` 均已通过，GitHub Actions 在 push/PR 上运行同一组检查。Routing、Judge、Machine Approval 的主要分支由 Cordis waterfall 集成测试覆盖，但示例 profile 默认未开启 Routing/Judge，不能把这些测试等同于真实 Web 会话验证。相关设计与风险取舍见 [设计文档](design.md) 和 [v2 计划](v2-plan.md)。

## 隐私与审计

两个宿主默认对发往 Jev 的状态做**本地脱敏**：常见密钥形态（GitHub/GitLab/Slack/AWS/Anthropic/OpenAI/Google key、JWT、Bearer、PEM 私钥块）和敏感键名（`api_key`、`token`、`authorization` 等）下的字符串值会替换为 `[REDACTED:*]` 占位符。这是尽力而为的识别，不能保证覆盖所有私密内容；需要完整原文判断时可配 `privacy.outbound: raw`（pi 用 `PI_DECISION_OUTBOUND=raw`），此时建议只对低风险工具集开启 guardrail。

每次判定都会写一条 sanitized 审计记录（JSONL，默认在 `$XDG_STATE_HOME/dsh-decision/` 下，dsh 为 `dsh-audit.jsonl`、pi 为 `pi-audit.jsonl`；dsh 记录含 `sessionId` 可与会话关联），字段只有：时间、宿主、切面、模式、工具名、判定、policyVersion、各维概率、脱敏计数、粗粒度错误类别——**不含工具参数、结果或提示原文**。dsh 侧同时通过 Cordis 事件 `decision/trace` 广播同一记录，供未来观测面板订阅。

把判定写进 dsh 的 session 事件日志是 v2 计划的方向，但当前**有意未做**：上游契约要求仓库外事件类型必须带 `ignorable` 标记才能被恢复路径安全跳过，而 `Session.append`（0.1.7-rc.2 与上游 master 均是）没有设置该标记的入口；未带标记的自定义事件可能导致 session 恢复被拒绝。等上游提供受支持的写入通道后再迁移，审计文件里的 `sessionId` 保持会话关联。

## 阈值评估

六维阈值是实验值。`packages/decision-jev/eval/` 提供校准工作台（v2 计划 Phase 5 的地基）：

```sh
pnpm run build
AI_GATEWAY_API_KEY=... pnpm run eval            # 真实调用 Jev，写 eval/results-<date>.json
pnpm --filter @techs/dsh-decision-jev run eval --replay packages/decision-jev/eval/results-<date>.json  # 离线重放
```

live 模式对 `fixtures.json` 里的人工标注用例（良性/破坏性/外传/提权/敏感读取）逐个求六维概率并落盘（请求间隔默认 400ms，`EVAL_DELAY_MS` 可调；429/5xx 逐用例退避重试，中断保留已完成部分）；replay 模式不碰 API，输出当前默认阈值的混淆矩阵、误判清单，以及统一阈值网格的 Pareto 前沿。`eval:analyze` 输出逐维分离度报告和边际感知的阈值提案（可直接粘贴进配置）。换环境或换模型的自助校准流程、指标定义和 `externalSideEffect` 提问改写案例见 [评估方法](eval.md)。

**2026-09-26 校准记录**（`typesafe-ai/jev`，22 用例，两轮）：第一轮暴露旧阈值良性误阻断 75%，重校后 0%/漏放 0%；第二轮修复 `externalSideEffect` 提问措辞的倒挂（工作区写入 0.74 > 群发邮件 0.71）后整组重校，最终误阻断 0%、漏放 0%、deny 软化 0，边际 ≥0.05。原始概率在 `eval/results-2026-09-26.json`（改写后）与 `eval/results-2026-09-26-original-instructions.json`（改写前基线），可用 replay/analyze 复核。

## 开发与分发

`packages/decision` 提供不引入 Cordis/Schemastery 运行时依赖的 `./kernel` 子路径，`packages/decision-jev` 提供 `./provider` 和 `./spec` 子路径，pi 扩展只在类型位置导入 pi 的 `ExtensionAPI`。本地 `pi -e` 和 `pi install ./packages/pi-decision` 依赖 pnpm workspace 链接；当前三个包都是私有包，发布 npm 前要先发布依赖并替换 `workspace:` 版本。

新 Jev 类 provider 可实现 `@techs/dsh-decision` 的 `JudgmentProvider` 并注册到 `ctx.decision`：

```ts
export const inject = ["decision"];
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.decision.registerProvider(provider));
}
```

旧的 `DecisionAdapter` 仍可通过 `registerAdapter()` 注册，但它的 `calibrated` 布尔值不授予 v2 自动审批资格。发往外部 API 的 state 默认经本地脱敏（见[隐私与审计](#隐私与审计)），未识别的私密内容仍可能发出；风险阈值也尚未校准，可用[评估工作台](#阈值评估)跟踪误判率。
