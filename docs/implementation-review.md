# dsh-decision 实现评估与迭代建议

评估日期：2026-09-28

## 结论

项目的总体架构方向合理，已经形成清晰的 `State → Judgments → deterministic Policy → Action` 分层：判断模型负责输出结构化概率，纯策略负责决定动作，dsh 与 pi 负责宿主接入。核心策略有版本标识，默认使用 `shadow`，Jev 也没有在缺少领域证据时获得自动审批资格。这些设计适合继续扩展 provider、策略和宿主。

当前版本更适合在 `shadow` 下积累真实数据。生产级 `enforce` 和自动审批还需要先处理决策一致性、长内容检查、评估覆盖和运行时资源控制等问题。

本次评估没有修改实现代码。评估时工作区原有的 CI、发布和文档改动保持不变。

## 验证结果

本地验证使用 mise 提供的 Node.js 26.10.0 和 pnpm 11.27.1，结果如下：

- 三个包共 86 个测试全部通过。
- 构建和 TypeScript 类型检查通过。
- oxlint 和 oxfmt 检查通过。
- 2026-09-26 的 Jev 结果可离线回放。

离线回放的三态结果为：

| 人工标注 | 样本数 | 当前判定     |
| -------- | -----: | ------------ |
| `allow`  |      8 | 8 个 `allow` |
| `review` |      2 | 2 个 `deny`  |
| `deny`   |     12 | 12 个 `deny` |

README 中“良性误阻断 0%、deny 漏放 0%”可以复现，但这两个指标没有体现两个应转人工的样本都被直接拒绝。当前结果说明策略在种子集上守住了允许与拒绝两端，尚未正确区分 `review` 和 `deny`。

## 已确认问题

### P1：自动审批资格可能与实际判断模型不一致

审批流程先等待 `decision.evaluate()`，随后通过 `this.decision.provider()` 重新读取当前 provider 的能力和模型。相关实现位于 [`packages/decision/src/index.ts`](../packages/decision/src/index.ts)。

如果 provider 在判断进行期间被卸载并以相同 id 热替换，旧 provider 返回的判断可能套用新 provider 的校准资格。评估中已用本地模拟复现以下过程：

1. 未取得自动放行资格的旧模型开始判断。
2. 判断尚未返回时，将 provider 替换为具有匹配资格的新模型。
3. 旧模型返回高放行概率。
4. 资格检查读取新模型，最终返回 `allowed-once`。

默认 Jev 不携带自动放行资格，因此默认配置不会直接触发这个问题；一旦部署方配置了合格 provider 并支持热替换，它会破坏“资格必须绑定实际生成判断的模型”这一不变量。

建议在一次请求开始时固定 provider 实例、provider id、model 和 calibration 快照；资格判断应使用实际 `JudgmentResult` 对应的 provider/model，并防止同 id 的实例替换改变在途请求语义。

### P1：审计事件订阅者异常会产生未处理的 Promise 拒绝

[`packages/decision/src/index.ts`](../packages/decision/src/index.ts) 的审计逻辑使用 `void this.ctx.parallel("decision/trace", record)` 发布事件，但没有处理返回 Promise 的拒绝。

本地模拟注册了一个会抛错的 `decision/trace` 订阅者。工具决策仍然返回 `allow`，但进程收到了一个未处理的 `AggregateError`。`shadow` 模式同样会触发，因此可选的观测订阅者可能影响宿主进程稳定性。

建议捕获事件发布失败，记录有限且脱敏的告警，并增加“审计 sink 和事件订阅者故障不影响工具执行”的回归测试。

### P1：Judge 只检查长结果的前缀

[`packages/decision/src/seams/judge.ts`](../packages/decision/src/seams/judge.ts) 只把工具结果的前 8,000 个字符发给判断模型。如果结果被接受，完整原始内容仍会进入主模型上下文。

这意味着尾部的 prompt injection、密钥或私密数据可能完全没有接受检查。评估中构造了一个 8,000 字符正常前缀加恶意尾部的结果，发送给 Judge 的 state 不包含尾部标记。

建议优先考虑分块检查并进行确定性聚合。若成本限制不能检查全文，应在 state 和 trace 中显式记录截断，并为“检查不完整”设置可配置的保守策略。仅检查前缀时，不应把 verdict 表述为对完整结果的判断。

### P2：分类与有序概率分布校验不完整

[`packages/decision/src/judgment-validation.ts`](../packages/decision/src/judgment-validation.ts) 和兼容接口的校验只检查已有概率项是否合法，没有要求概率项完整、总和接近 1，也没有验证 choice、confidence 和分布之间的一致性。

以下响应目前都能通过分类结果校验：

- 空的 `probabilities`，同时给出高 confidence。
- 两个选项概率均为 0.9，总和为 1.8。
- 选中 `large`，但分布为 `small: 1, large: 0`。

路由策略优先使用 `confidence`，因此不一致的响应仍可能改变模型路由。Jev wire adapter 也接受空分布。

建议先明确完整分布还是稀疏分布的接口契约，然后校验：

- 所有声明选项是否必须出现。
- 概率总和是否在允许误差内接近 1。
- choice 是否与最大概率项一致。
- confidence 的定义及其与选择概率的关系。
- ordinal score 是否与概率分布的期望位置一致。

### 发布前问题：tag 与包版本比较不一致

当前工作区新增的 [`.github/workflows/release.yml`](../.github/workflows/release.yml) 监听 `v*` 标签，但将完整 tag 直接与 package version 比较。例如标签是 `v0.1.1`，包版本是 `0.1.1`，现有检查会失败；查询 npm 已发布版本时也使用了带 `v` 的版本值。

建议同时保留两个变量：原始 `tag=v0.1.1` 用于 GitHub Release，去掉前缀后的 `version=0.1.1` 用于 package.json 和 npm 比较。发布工作流合入前应增加一次 dry-run 或脚本级测试。

## 后续优化方向

### 1. 补齐决策所需的上下文

[`packages/decision/src/seams/guardrail.ts`](../packages/decision/src/seams/guardrail.ts) 当前只向 provider 提供工具名和参数，却要求判断 `scopeViolation`。缺少用户目标、明确授权、工作区边界和目标环境时，模型无法可靠地区分“用户要求执行生产部署”和“agent 擅自执行生产部署”。

建议引入最小化、可脱敏的 `DecisionContext`，至少包含：

- 当前任务摘要。
- 用户明确授予的权限或限制。
- 当前工作区或资源边界。
- 操作目标是本地、共享环境还是生产环境。
- 上一步决策和审批来源。

上下文需要在本地先提取和脱敏。信息不足时，判断结果应能表达“不确定”，由策略决定转人工或拒绝，而不是强迫模型输出看似精确的风险概率。

### 2. 让评估与实际运行经过同一条输入处理链

[`packages/decision-jev/eval/run-eval.mjs`](../packages/decision-jev/eval/run-eval.mjs) 在 live eval 中直接把 fixture 参数发给 provider，实际运行默认会先做脱敏。因此当前校准数据和真实运行输入并不完全一致。

建议把“构建 state、脱敏、截断、调用 provider、验证结果”提取为宿主无关的公共执行器，运行时和评估工具共同使用。每份结果文件还应记录：

- provider、model、endpoint 类型。
- 问题文本或问题集摘要。
- policyVersion。
- 脱敏器和截断策略版本。
- 完整的有效配置快照。
- 运行时间与重复轮次。

评估集应加入独立保留集、跨日重复、逐维风险标签，以及“相同操作，授权上下文不同”的成对样本。当前 22 个样本更适合称为种子集上的阈值调优，还不足以证明概率已经校准。

### 3. 建立判断、实际动作和结果之间的审计关联

[`packages/decision/src/trace/trace.ts`](../packages/decision/src/trace/trace.ts) 当前记录 seam、action、概率、policyVersion 和 sessionId，但缺少调用 ID、实际 provider/model、耗时、实际采用的动作、工具最终结果和人工最终决定。

建议后续 trace 区分：

- `judgment`：模型返回的概率和元数据。
- `policyAction`：纯策略建议的动作。
- `effectiveAction`：宿主最终采用的动作。
- `outcome`：工具是否执行、是否成功，以及人工审批结果。

这些记录应由稳定的 decision/call id 关联，同时继续保持 trace 内不含原始参数和结果。这样才能计算真正的误阻断、漏放、人工改判率、延迟和成本。

隐私边界还应覆盖异常与日志。[`packages/decision-jev/src/client.ts`](../packages/decision-jev/src/client.ts) 会把最多 200 字符的 HTTP 响应正文放进异常，异常之后可能进入日志或 guardrail 的失败原因。JSONL trace 已脱敏，并不代表其他输出通道也已安全。

### 4. 统一 dsh 与 pi 的执行语义

dsh 通过 `DecisionRuntime` 执行判断，pi 的 [`packages/pi-decision/src/handler.ts`](../packages/pi-decision/src/handler.ts) 则直接调用 provider。两条路径在超时、能力检查、结果验证和未来重试策略上容易逐渐分叉。

建议提取宿主无关的 judgment executor，统一负责：

- provider 能力检查。
- 组合取消信号和超时。
- 结果及 provider/model 身份验证。
- 可选的重试和熔断。
- 安全审计元数据。

dsh 和 pi 只负责将宿主事件映射到统一输入，并把策略动作映射回宿主结果。

### 5. 为 shadow 增加资源上限和生命周期管理

shadow 路径会立即放行主流程并在后台启动判断，但当前没有并发上限。评估中模拟 100 个顺序工具调用时，产生了 100 个同时待完成的判断请求。

建议加入：

- 有界并发队列。
- 队列满时的采样或丢弃策略，并记录 dropped trace。
- provider 级熔断和退避。
- session 或插件退出时的取消与有限时间 drain。
- 调用量、延迟、错误率和估算成本指标。

完成这些基础设施后，再根据真实数据判断是否需要按规范化输入和 policyVersion 做短期缓存。

### 6. 改进三态策略与评估指标

当前两个 `review` 样本都被判为 `deny`。对于强调人工兜底的系统，`review → deny` 与 `deny → review` 都应成为一等指标，而不能只观察良性误阻断和 deny 漏放。

建议至少报告：

- `allow → review/deny`。
- `review → allow/deny`。
- `deny → allow/review`。
- 每个维度的 ROC/PR 或阈值敏感性。
- 跨重复运行的概率方差。
- 人工最终决定与机器建议的一致率。

在三态样本和真实反馈足够之前，保持 `enforce` 的实验标记是合理的。

## 建议迭代顺序

1. 修复自动审批资格竞态、审计事件未处理拒绝、长结果检查盲区和发布 tag 比较。
2. 收紧 JudgmentResult 分布契约并补回归测试。
3. 引入最小化的 DecisionContext，优先解决 `scopeViolation` 缺少任务上下文的问题。
4. 统一运行时与评估输入处理，扩充三态评估集和保留集。
5. 扩展 trace，使机器判断、策略动作、人工决定和实际结果可关联。
6. 统一 dsh/pi 执行器，加入 shadow 并发、熔断和生命周期管理。
7. 基于真实审计数据继续校准策略，再评估是否扩大 `enforce` 和自动审批范围。

在完成前两项之前，不建议为系统增加更多风险维度；先保证现有六维的输入、结果验证和执行边界可信，会带来更直接的可靠性提升。
