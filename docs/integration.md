# 接入与验证

本仓库提供宿主无关的概率判断接口与策略，Jev 是首个 provider 实现。示例配置把 Jev 用在两个宿主：pi 监听 `tool_call`，dsh 使用自身的 waterfall 扩展点。pi 目前只判断**调用工具前**的风险；dsh 另有路由、结果 judge、机器审批切面。两边的默认执行模式都是 `shadow`。其他能返回结构化概率判断的模型可通过各自 adapter 接入 dsh 核心，不要求兼容 Jev 的 API；pi 扩展当前仍直接绑定 Jev adapter。

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

**`enforce` 是实验特性。** 当前问题、上下文和策略尚无足够 live 评估来校准；旧版 22 个用例与结果不能代表当前行为。缺少用户请求或工作区边界时，依赖这些信息的风险会转为人工复核。外部副作用高分默认要求复核，单靠用户请求文本不会生成精确动作授权；内置 dsh 与 pi 集成尚未连接授权授予 UI。启用时扩展会向 stderr 打一条警告。每次判定（shadow 和 enforce 都）会写一条 sanitized 审计记录到 `PI_DECISION_AUDIT_PATH`，内容只有判定、概率、policyVersion、脱敏计数和粗粒度错误类别，不含工具参数原文。

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
  # risks: # 省略时使用实验性内置默认；先运行当前版评估
  #   secretExposure: { reviewAt: 0.55, denyAt: 0.85 }
  #   destructive: { reviewAt: 0.45, denyAt: 0.55 }
  #   scopeViolation: { enabled: false } # 一等关闭：不发问、不判定、不出站
  #   externalSideEffect: # 改写问题或 criteria 后重新采集评估数据
  #     instructions: "Does this action send a message or upload data?"
  #     criteria: { true: "Sends or uploads data.", false: "Only performs a read or local edit." }
  # customRisks: # 用户自定义维度，追加在内置之后；与内置同权参与聚合
  #   financialExposure:
  #     instructions: "Could this tool call move money or initiate irreversible financial transactions?"
  #     reviewAt: 0.3
  #     denyAt: 0.7
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

独立的 `decision` profile 使用 headless bundle；已有的 dsh Web 进程使用 `web` profile，两者需要分别加载插件。发布版可以直接安装：

```sh
dsh plugin --profile web add @techs/dsh-decision @techs/dsh-decision-jev
```

若从仓库调试，可从根目录改用本地包：

```sh
dsh plugin --profile web add "file:$(pwd)/packages/decision" "file:$(pwd)/packages/decision-jev"
```

两个包从 0.1.1 起各自声明 `dsh.bundle`；dsh 安装时会将决策层和 Jev adapter 的 patch 加入 profile，无需复制示例 patch。包内 patch 默认使用 Gateway、`AI_GATEWAY_API_KEY`、`shadow` 和原生权限模式。key 必须对启动 dsh 的进程可见；本机将其放在权限为 600 的 `~/.dsh/.env`。安装后重启 Web 进程。要启用机器审批、路由等配置，再参考[示例 patch](../profile/cordis.patch.yml) 在 `~/.dsh/profiles/web/cordis.patch.yml` 中覆盖相应插件行。

### 验证范围

| 路径             | 已验证                                                                                                                         | 尚未做端到端验证                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 独立 dsh profile | `glm-5.3-flash` 真实工具调用；shadow 下工具继续执行；临时 enforce patch 触发 guardrail 拒绝，session 日志记录原因              | 路由、结果 judge、人工审批 UI                                  |
| dsh Web profile  | 插件进入配置并成功启动本地 HTTP 服务；未认证请求返回 401                                                                       | 浏览器对话触发工具和审批                                       |
| Jev Gateway      | 真实请求返回有效判断；guardrail 一次请求取得六维答案；旧版 22 样本结果已归档，不能校准当前问题和策略（见 [评估方法](eval.md)） | 当前提示词与策略的重复评估、长期误判率、跨日稳定性与更大标注集 |
| pi 扩展          | Flash 主模型调用只读工具，Jev shadow 完成判断；enforce 的 allow/review/deny 和失败策略有自动化测试                             | 真实交互中的人工复核体验                                       |

`pnpm run typecheck`、`pnpm run test`、`pnpm run lint` 和 `pnpm run fmt` 是本地检查命令；GitHub Actions 在 push/PR 上运行同一组检查。Routing、Judge、Machine Approval 的主要分支由 Cordis waterfall 集成测试覆盖，但示例 profile 默认未开启 Routing/Judge，不能把这些测试等同于真实 Web 会话验证。相关设计与风险取舍见 [设计文档](design.md) 和 [v2 计划](v2-plan.md)。

## 隐私与审计

两个宿主默认对发往 Jev 的状态做**本地脱敏**：常见密钥形态（GitHub/GitLab/Slack/AWS/Anthropic/OpenAI/Google key、JWT、Bearer、PEM 私钥块）和敏感键名（`api_key`、`token`、`authorization` 等）下的字符串值会替换为 `[REDACTED:*]` 占位符。这是尽力而为的识别，不能保证覆盖所有私密内容；需要完整原文判断时可配 `privacy.outbound: raw`（pi 用 `PI_DECISION_OUTBOUND=raw`），此时建议只对低风险工具集开启 guardrail。

每次判定都会写一条 sanitized 审计记录（JSONL，默认在 `$XDG_STATE_HOME/dsh-decision/` 下，dsh 为 `dsh-audit.jsonl`、pi 为 `pi-audit.jsonl`；dsh 记录含 `sessionId` 可与会话关联），字段只有：时间、宿主、切面、模式、工具名、判定、policyVersion、各维概率、脱敏计数、粗粒度错误类别——**不含工具参数、结果或提示原文**。dsh 侧同时通过 Cordis 事件 `decision/trace` 广播同一记录，供未来观测面板订阅。

把判定写进 dsh 的 session 事件日志是 v2 计划的方向，但当前**有意未做**：上游契约要求仓库外事件类型必须带 `ignorable` 标记才能被恢复路径安全跳过，而 `Session.append`（0.1.7-rc.2 与上游 master 均是）没有设置该标记的入口；未带标记的自定义事件可能导致 session 恢复被拒绝。等上游提供受支持的写入通道后再迁移，审计文件里的 `sessionId` 保持会话关联。

## 阈值评估

六维阈值是实验值。`packages/decision-jev/eval/` 提供校准工作台（v2 计划 Phase 5 的地基）：

```sh
pnpm run build
AI_GATEWAY_API_KEY=... node packages/decision-jev/eval/run-eval.mjs --repeat 3 --out packages/decision-jev/eval/results-current.json
node packages/decision-jev/eval/run-eval.mjs --replay packages/decision-jev/eval/results-current.json
node packages/decision-jev/eval/analyze.mjs packages/decision-jev/eval/results-current.json
```

live 模式默认使用 `fixtures-contextual.json`，对带用户请求、工作区和可选精确 host grant 的人工标注样本逐个求六维概率并落盘（请求间隔默认 400ms，`EVAL_DELAY_MS` 可调；直连端点慢于客户端默认 8s 超时时用 `JEV_TIMEOUT_MS` 调大；429/5xx 逐样本退避重试，中断保留已完成部分）。replay 不碰 API，按 calibration 与 holdout 分开报告混淆矩阵和误判；`eval:analyze` 只用 calibration 提案阈值，再单独报告 holdout，并按各风险维度的 true/false 标签统计分离度，未知标签不会当作 false。样本少时这些结果只能帮助发现问题，不能证明生产准确率。更多流程见 [评估方法](eval.md)。

**2026-09-26 旧版记录**（`typesafe-ai/jev`，22 用例，两轮）仅用于说明历史问题措辞的边界：旧 `externalSideEffect` 问题曾将工作区写入打成 0.74，高于群发邮件的 0.71。之后问题、criteria、上下文、授权判定和动作策略均发生变化。归档概率可供 exploratory replay，但不能据此声称当前提示词或默认阈值已校准；具体限制见[评估说明](eval.md)。

## 开发与分发

`packages/decision` 提供不引入 Cordis/Schemastery 运行时依赖的 `./kernel` 子路径，`packages/decision-jev` 提供 `./provider` 和 `./spec` 子路径，pi 扩展只在类型位置导入 pi 的 `ExtensionAPI`。本地 `pi -e` 和 `pi install ./packages/pi-decision` 依赖 pnpm workspace 链接（pnpm 版本由根 `package.json` 的 `packageManager` 锁定为 11.27.1，11 的原生 `pnpm publish` 支持 npm Trusted Publishing）。

发布是全自动的：把三个包 bump 到同一版本、提交后推 tag `vX.Y.Z`，`.github/workflows/release.yml` 会跑完整校验、校验 tag 与所有 `packages/*/package.json` 版本一致、创建 GitHub release，然后按拓扑序（decision → decision-jev → pi-decision）逐包 `pnpm publish --no-git-checks`，`workspace:` 版本自动替换为实际版本；逐包幂等跳过已发布版本，部分失败可直接重跑同一 workflow。npm 认证走 OIDC Trusted Publishers，不需要 `NPM_TOKEN`；前提是在 npmjs.com 后台为三个包各绑定一条 Trusted Publisher，内容须与 workflow 完全一致（大小写敏感）：仓库 `yourtion/dsh-decision`、workflow filename `release.yml`、不填 environment。Trusted publishing 未绑定或 CI 不可用时，回退手工发布：从各包目录按拓扑序单独 `pnpm publish --no-git-checks`（不要从根重跑 `pnpm -r publish`，会在已发布的包上报错中断）。发布后使用 `pi install npm:@techs/pi-decision` 或 `dsh plugin --profile web add @techs/dsh-decision @techs/dsh-decision-jev`，不依赖本地仓库。发布前应分别用 npm tarball 在干净的 pi 和 dsh profile 中验证安装。

接入其他概率判断模型时，实现 `@techs/dsh-decision` 的 `JudgmentProvider`，把该模型的请求与响应映射为具名的 `JudgmentRequest` / `JudgmentResult`，声明支持的 binary、categorical、ordinal 问题类型，并注册到 `ctx.decision`：

```ts
export const inject = ["decision"];
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.decision.registerProvider(provider));
}
```

在 dsh profile 中安装新 provider 插件，并把 `decision.config.provider` 设为它注册的 `id`；所启用切面需要的问题类型必须由它支持。是否使用 Jev 的 TypeSafe System One wire 格式只影响 adapter 实现，不影响核心策略。现有 pi 包的入口直接调用 `createJevProvider()`，所以不能只改环境变量就切换到其他模型；要给 pi 增加对应 adapter 的创建与选择逻辑。

旧的 `DecisionAdapter` 仍可通过 `registerAdapter()` 注册，但它的 `calibrated` 布尔值不授予 v2 自动审批资格。发往外部 API 的 state 默认经本地脱敏（见[隐私与审计](#隐私与审计)），未识别的私密内容仍可能发出。当前默认阈值尚未被当前版提示词与策略校准；换模型或修改问题后都应使用[评估工作台](#阈值评估)重新采集，在 `shadow` 下观察实际误判率，再考虑 `enforce`。
