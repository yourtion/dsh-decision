# dsh-decision v2 实施基线

## 结论

采用 `State → Judgments → deterministic Policy → Action` 作为 v2 目标。当前四个 seam 已经具备一次请求提交多个问题的能力，但 Guardrail、Judge 与 Approval 仍各自直接用概率阈值决定行为；Routing 还从尚未提交的 Session 中反查输入。分阶段迁移是合理的。

以下约束修正原提案中容易被误解的部分：

1. **Machine 不是 DSH 已存在的权限档位。** DSH 目前将审批策略 `ask | never` 与部署层权限预设结合。v2 的 `permission: auto | machine | full-access` 要先明确与原生预设、sandbox、tool policy 的映射；本插件不能仅凭跳过自身 guardrail 就承诺 Full Access。
2. **审批来源必须穿过真实事件边界。** 上游 `ApprovalRequestEvent` 没有 `origin` 字段。Phase 0 在本插件产生的 `ask.reason` 上加可识别标记；该标记只让机审委托人工，伪造也不会获得放行。长期应推动上游加入结构化 `origin` 或在同一调用标识上关联来源。
3. **未经验证的概率不能支撑自动放行。** 原 Jev adapter 声明 `calibrated: true`，但仓库没有相关模型、领域、样本和指标；Phase 0 将其改为 `false`。Phase 2 默认关闭自动 `allowed-once`，直到有可审计的 `provider + model + domain + policyVersion` 资格记录。阈值只作为实验配置。
4. **Shadow 必须旁路运行。** 外部模型评估不得挡住 `next()`；错误必须被记录并吞掉。严格的“除了延迟之外完全等价”还要求不改变持久状态、审批、路由、结果及取消路径；后台资源竞争需要通过集成测试和运行指标观察。
5. **Sanitizer 不能承诺识别所有秘密。** 未识别的私密数据仍可能出现在任意工具参数或结果中。Phase 3 要设默认出站数据策略、明确不支持的内容，并给检测失败定义拒发或本地回退行为。
6. **Policy 输入应固定并版本化。** 判定函数只依赖规范化 state、已验证 judgments、配置快照和 policyVersion；时间、随机数、网络调用与日志写入都在函数外。不同风险的拒绝优先于复核，复核优先于放行。

## 实施顺序与验收

### Phase 0：现有语义正确性

- Routing 取 `agent/pre-step` 最终接受的消息，按 Agent、turn、step 隔离，在 `agent/request` 消费并清理。
- Guardrail 自己发起的复核跳过 Machine Approval；失败策略产生的 `ask` 也遵守这一规则。
- Jev 响应按原问题校验类型、概率、选项、置信度和缺失答案；故障走现有失败策略。
- Shadow 评估旁路运行，所有 seam 立即委托原链。
- Cordis `ctx.decision` 服务公开 `registerAdapter()`，让 Jev 和其他 provider 能实际注册。
- 集成测试覆盖真实 Cordis/DSH 事件链，尤其是接纳消息、审批来源和 shadow 行为。

当前进度：前五项已落地并有 Cordis waterfall 测试；测试直接驱动 DSH 声明的事件，尚未启动完整 AgentLoop、ToolRuntime 和 ApprovalService，因此真实工具执行与持久审批审计仍是本阶段验收门槛。上游缺少结构化审批来源时，reason 标记是当前版本的兼容方案。

### Phase 1：Judgment 与 Policy 分离

- 引入 Binary、Categorical、Ordinal 中立类型，Jev 在边界映射为 Noul、Choice、Score；保留旧 `DecisionAdapter` 兼容层。
- 引入 provider 能力和结果校验；Policy 函数纯净、版本化。
- Guardrail 一次评估六维风险，使用逐维 `reviewAt/denyAt` 与 `deny > review > allow` 聚合。六维独立性先由实际 policy effect 验证，不提前增设 severity。
- 以固定 trace 回放确认同输入、同版本给出同结果。

### Phase 2：Machine Decision

- 先完成与上游权限预设和审批事件的映射，再暴露 `permission × enforcement` 配置。
- `auto` 保留原生链；`machine` 只接管明确可机审的原生审批；`review` 交给 human 或按 `uncertain: deny` 拒绝；`full-access` 仍遵守实际 DSH sandbox/工具能力。
- 默认不自动允许未取得领域资格的 provider/model。集成测试覆盖允许一次、拒绝、人工委托、无人值守拒绝和 shadow。

### 后续

Phase 3 本地分析和脱敏；Phase 4 可脱敏的 DecisionTrace 与实际 outcome 关联；Phase 5 基于真实样本评估和调参。UI、预设、fast path 等数据依赖较强的工作随后进行。

## 核心不变量

1. Judgment 只报告判断；Policy 决定行为。
2. 同样的规范化输入、judgments 和 policyVersion 得到同样的决策。
3. 决策层升级的 review 不能再次由机器批准。
4. Shadow 不能改变 Agent 的决策与执行结果。
5. 外部 provider 默认只接收明确允许出站的状态；本地可提取的敏感信号先本地提取。
6. Machine 的不确定性默认升级给 human。
7. 自动放行资格按 provider、model、domain、policyVersion 和评估证据限定。
8. 每个强制执行的机器决策都能关联可审计的判断、policyVersion 和实际结果，trace 本身必须脱敏。
