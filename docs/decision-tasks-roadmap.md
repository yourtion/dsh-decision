# 新决策任务调研与迭代计划

调研日期：2026-10-02。仓库基线：`31c62fc91e9a`，三个发布包版本为 `0.2.0`。

本文记录五个候选方向的调研结果、纳入项目的评估逻辑和开发顺序。它是后续迭代的设计基线；五项新能力尚未实现，也未开展对应的 live 评估。文中的输入示例、动作和模块名是设计提案，开发时需要固化为类型、schema 和版本化策略。

既有 guardrail、routing、judge 和 approval 的实施状态继续以 [v2 实施基线](v2-plan.md)及[接入与验证](integration.md)为准。本文不替代当前工具风险策略，也不授予新的自动审批资格。

## 1. 结论与项目范围

继续采用 `State → Judgments → deterministic Policy → Action`：判断模型回答可核对的问题，代码决定动作，宿主应用动作。日志采集、技能正文加载、工具执行、信息生成和记忆存储分别由宿主适配或独立模块承担。

| 编号 | 方向                         | 纳入建议               | 首次交付边界                                               | 优先级依据                                                   |
| ---- | ---------------------------- | ---------------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| 1    | 长轨迹中的原文事件筛选       | 纳入可选上下文决策任务 | 离线选择与回放，然后接入 pi；选中文字保持原文              | 符合判断与确定性选择的定位，但需要依赖保护和宿主投影         |
| 2    | 按本轮需求选择技能           | 优先纳入               | shadow 记录推荐，验证后向 agent 推荐技能，保留原生发现能力 | 两个宿主已有按需加载机制，新增价值可通过错选、漏选和成本衡量 |
| 3    | 自然语言映射函数与参数       | 拆分纳入               | 先验证已有调用的参数语义；封闭工具集的 dispatcher 后续可选 | 宿主已有类型校验；通用自由参数生成超出当前判断接口           |
| 4    | 轻量抽取、字段验证、推理升级 | 有真实抽取需求时纳入   | 通用字段验证与升级策略，抽取和重新生成独立                 | 策略与项目架构相符，但当前仓库没有抽取工作负载证明收益       |
| 5    | 轨迹佐证的经验升级为记忆     | 后置纳入               | 先生成、评估候选经验，再考虑持久写入                       | 依赖轨迹完整性、实际结果关联、适用范围和记忆后端             |

实施顺序为 **2 → 1 → 3 的参数语义验证**；有代表性抽取任务时推进 **4**；补齐轨迹与实际结果关联后推进 **5**。3 的完整 dispatcher 不作为默认 agent loop 的替代品。开发 1、2 时即可增补必要的审计关联字段，无需等待完整记忆系统。

## 2. 已核实的能力与接入位置

### 2.1 仓库基线

- [`JudgmentRequest` 和 `JudgmentProvider`](../packages/decision/src/judgment.ts)支持 binary、categorical、ordinal。新任务可复用这些原语；接口不提供任意文本生成或任意参数抽取。
- dsh [`DecisionLayer`](../packages/decision/src/index.ts)接入 `tools/pre-execute`、`agent/request`、`tools/post-execute`、`approval/request`，并通过 `agent/pre-step` 捕获最终接纳的输入。
- pi [`扩展入口`](../packages/pi-decision/src/index.ts)目前只注册 `tool_call`，直接创建 Jev provider。它尚无技能选择、上下文筛选、抽取升级或记忆整理行为。
- dsh [`DecisionRuntime`](../packages/decision/src/service.ts)已有能力检查、超时、取消和结果身份校验；pi [`handler`](../packages/pi-decision/src/handler.ts)直接调用 provider 后校验答案。新增任务应共享一致的执行语义，避免继续复制两套逻辑。
- [`DecisionTraceRecord`](../packages/decision/src/trace/trace.ts)只有四类 seam，记录判断概率、动作和策略版本等，不含原始参数、结果、调用 ID 或实际执行结果。它是判定审计，不是完整运行轨迹。
- [`JudgmentDomain`](../packages/decision/src/judgment.ts)和 `TraceSeam` 目前都是四项封闭联合类型；新增任务标识、答案审计格式和任务评估身份需要明确扩展或另建版本化契约。

宿主契约核对基于 dsh `0.1.7-rc.2` 和本地安装的 pi `0.87.1`；依赖声明见 [dsh package.json](../packages/decision/package.json)及 [pi package.json](../packages/pi-decision/package.json)。上游链接指向调研时的最新文档，不能据此承诺旧版宿主兼容。开发时应重新核对目标版本，并记录实际测试版本。

### 2.2 宿主映射

| 任务           | dsh 接入位置                                                                                              | pi 接入位置                                                                     | 仍需实现或验证                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 原文事件筛选   | `session/event` 采集；`agent/pre-step` 触发；Session surface、message projection 和 compaction 为相关机制 | `context` 做请求消息筛选；在可写生命周期边界提交 `context_edit` 实现持久投影    | dsh 任意事件保留的投影契约；pi 与自动压缩、分支和 token 预算的协同   |
| 技能选择       | `ctx.skills.snapshot()/get()` 获取目录和正文；`agent/pre-step` 接纳本轮相关指令                           | `before_agent_start` 的 prompt 与 `systemPromptOptions`；技能正文由加载流程提供 | 推荐注入、显式调用优先、多个技能选择和历史正文生命周期               |
| 参数语义验证   | `defineTool` 的本地 schema 校验；`tools/pre-execute` 检查拟执行调用                                       | `registerTool` 的参数 schema；`tool_call` 检查拟执行调用                        | 业务约束、语义证据、后续参数变更与最终执行参数的一致性               |
| 字段验证与升级 | 抽取工具或 workflow 内部；现有 judge/routing 提供思路                                                     | 自定义工具内部编排抽取、验证和升级                                              | 源文本与字段 schema 传递、重新生成和再次校验；不是单纯复用安全 judge |
| 经验升级       | `session/event` 与恢复后的轨迹回放；结果关联；另接记忆后端                                                | 消息、工具执行和结果事件；`agent_settled` 后异步整理；另接外部存储              | 候选经验生成、证据覆盖、适用范围、冲突与写入生命周期                 |

接入限制来自以下已核对契约：

- dsh 的 `agent/pre-step` 处理本 step 的用户消息；`agent/request` 替换 `LlmCallConfig`，不是历史消息过滤接口。影响历史输入的变化应使用可恢复、可回放的日志投影，不能只临时改写请求载荷。[dsh Session](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md)
- dsh compaction 的成功路径是将选定区间替换为一个摘要节点。现有 message projection 能解释插件持久化的内容变化，但不能直接据此假定已支持任意非连续事件删除。需要先完成原文保留投影的设计与宿主验证。[dsh Compaction](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/compaction.md)
- pi 的 `context` 是请求时的消息变换；`context_edit` 的 `replacement: null` 可持久化移除目标的模型上下文贡献，原始历史保留。扩展上下文中的 session manager 是只读视图，持久修改需走可写边界的 entry draft 或相应受支持接口。请求时过滤本身不会改变 canonical token 预算和持久压缩结果。[pi Extensions](https://pi.dev/docs/latest/extensions)、[pi Session format](https://pi.dev/docs/latest/session-format#contexteditentry)
- pi 的 `agent_end` 后仍可能重试、压缩或处理排队任务。需要等待运行真正结束的整理使用 `agent_settled`；需要改变继续执行行为时另用可写边界。[pi 生命周期](https://pi.dev/docs/latest/extensions#respect-the-runtime-lifecycle)

## 3. 是否加入项目的评估逻辑

每项按以下顺序回答问题，不以“模型可以回答”作为立项或上线依据：

1. **宿主是否已经解决问题？** 记录原生基线和实际错误；已有功能只能以可验证的增量收益立项。
2. **宿主能否提供足够事实？** 必须构造任务输入；标识缺失、截断、过期和分支差异不能被掩盖。
3. **问题是否适合判断原语？** 选择有限候选、判断事实和有序评级可交给 provider；生成候选、执行代码和保存数据由其他层承担。
4. **动作能否由代码确定？** 约束、未知状态、失败回退、依赖和版本必须可回放，不能只靠模型输出一句建议。
5. **是否守住宿主契约？** 类型、权限、消息角色、工具配对、取消和恢复语义需要实际验证。
6. **是否有净收益？** 同时比较质量、总费用、请求延迟和维护成本；减少主模型 token 不一定减少系统总成本。
7. **是否可以独立停用和回退？** 新任务默认关闭，先离线，再 shadow，再按任务应用；不把新增判断强制串入每次调用。

因此，2 的主要假设是减少技能选择错误；1 的主要假设是减少上下文成本而不损害后续任务成功；3 是检查类型正确但意图错误的参数；4 是以较低总成本得到可靠记录；5 是提高记忆写入的证据质量。它们必须分别验证，现有 guardrail 数据和阈值不能代替新任务评估。

## 4. 共同的任务构造与执行规则

### 4.1 输入、判断和动作分离

```text
宿主事实 / 候选生成结果
  → 规范化任务输入（inputVersion、证据引用、完整性）
  → 本地确定性校验
  → 构造允许出站的 state 与具名问题（questionVersion）
  → provider 判断与结果校验
  → 纯 Policy（配置快照、policyVersion）
  → 动作计划
  → 宿主应用、实际 outcome 关联和审计
```

任务元数据至少包括 `task`、`inputVersion`、`questionVersion`、证据身份和完整性。评估记录还需绑定 provider、请求/实际模型、策略版本、配置指纹、出站隐私版本和输入指纹。宿主对象、可执行函数和存储句柄不进入 `DecisionState`。

各任务的 `build…Request` 将规范化状态映射到现有 `JudgmentRequest`。Pure Policy 只返回动作计划，不能在内部读取文件、调用模型、加载技能、执行工具或写记忆。各判断应指向原子事实，多个判断的关系在代码中处理。[TypeSafe 原语与问题拆分](https://docs.typesafe.ai/introduction)

### 4.2 未知、失败和配置

- 单独表达候选缺失、上下文不足和不适用。分类问题应按任务提供 `none` 或 `insufficient_context` 等出口，不迫使模型选择一个不合适的候选。
- Binary 返回 `P(true)`，没有另一个 confidence 字段；Categorical/Ordinal 的 confidence 与选项概率是不同值。不得混用，亦不得假定逐项判断独立后直接相乘。
- 模型高概率不替代类型检查、引用验证或宿主权限。证据不完整时，不能把“没发现问题”解释为完整通过。
- 新任务分别配置 `off / shadow / apply`。Shadow 只旁路记录，不改变消息、技能加载、工具行为或持久记忆。给主模型注入技能推荐已经属于 apply；新增任务配置名称在实现时冻结。
- 应用失败按任务回退：技能推荐保持原生流程；原文筛选不提交不完整投影；调用验证未通过不执行；字段验证不能把故障当验证通过；记忆判断失败不升级候选。
- 原文筛选失败而原上下文已无法容纳时，返回明确的预算不足结果；不能悄悄改用生成摘要并宣称符合原文保留要求。
- 应用异步结果前核对 session、分支、目标、目录或候选版本，丢弃过期结果。只读观察事件不直接重入宿主的日志追加流程。

### 4.3 原始数据与审计

原始轨迹、模型可见投影、判断模型出站视图和 sanitized 判定审计分别管理。本地选择文本保持原文，与向外部 provider 发送脱敏视图并不冲突；通过稳定 ID 关联两者。脱敏导致关键信息不可判断时，标记未知。

完整轨迹指宿主可观察的输入、消息、工具调用和结果、错误、取消、重试、分支及嵌套调用；不假定能获得模型未返回的内部推理。只监听实时事件会漏掉恢复前历史，只读取压缩后的消息会漏掉被隐藏事件。需要轨迹源读取与实时订阅协同，并报告缺失覆盖。

审计应增补任务/决策 ID、session/branch 身份、源事件和调用引用、输入指纹、实际模型、完整性、耗时、拟议动作、实际动作及 outcome 关联。分类和有序答案不能被当前仅记录 Binary 概率的形式丢弃。完整参数和工具结果不因此复制到默认审计文件；关联字段和格式演进须保持旧记录可读。

## 5. 五项任务的开发规格

### 5.1 原文事件筛选：`context-retention`

**目标：** 在预算内选择后续任务需要的历史事件或文本片段，保留选中原文。原始日志不删除，不生成摘要替换选中内容。

输入示例：

```json
{
  "task": "context-retention",
  "inputVersion": "context-retention-v1",
  "goal": "修复解析器并保留旧格式兼容",
  "goalRevision": "g2",
  "events": [
    {
      "id": "e17",
      "role": "user",
      "text": "旧版日志仍然需要能够恢复。",
      "tokenCost": 16,
      "relatedIds": [],
      "complete": true
    }
  ],
  "protectedIds": ["e17"],
  "recentTailIds": ["e17"],
  "tokenBudget": 6000,
  "complete": true
}
```

上述 token 数仅为示例；真实成本由目标模型的计量器计算。宿主适配必须保留完整消息对象及事件引用，不能把消息简单拼成一段文字后丢失角色、调用 ID 和非文本块。

**判断：** 某事件是否含未完成目标的约束、仍有效的纠正、后续动作所依赖的事实，或可丢弃的重复信息。用 Binary 判断必要性；需要排序时另用有明确 rubric 的 Ordinal。

**策略与结果：** 返回 `retainedEventIds`，必要时返回经本地验证的原文区间。先保护强制指令、用户约束和近期消息，再选择候选，补齐依赖并重新计量。工具调用/结果及产生调用的消息必须保持一致；不会因低分删掉保护项。保护集合超预算时返回 `budget_exceeded`。片段从原文按明确定义的索引提取，校验实际内容一致，不接受模型重写文本。

**首版：** 先按完整消息或调用组筛选，避免提前实现任意字符区间。离线产出选择计划，再用 pi `context` 做实验；持久化通过 `context_edit` 并验证恢复、分支、自动压缩。dsh 先提交投影设计，验证任意保留的可表示性、事件恢复及插件卸载行为；不能只给 `ctx.compaction` 增加一个 Jev prompt。

**评估：** 关键约束召回、依赖完整性、原文一致性、保留 token、总费用/延迟、后续任务成功率。覆盖早期纠正、长工具结果、并行调用、非文本块、多轮“继续”、取消及分支。结构性原文一致和配对校验必须全部通过；关键约束的必保留标签必须全部保留。Shadow 只能评估选择计划；对后续成功率的因果判断需在隔离运行中实际应用候选上下文。

### 5.2 技能选择：`skill-selection`

**目标：** 提高技能选择质量，减少无必要正文加载。两宿主已有按需加载，首版以原生目录与 agent 自选为基线。[dsh Skills](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md)、[pi Skills](https://pi.dev/docs/latest/skills)

输入示例：

```json
{
  "task": "skill-selection",
  "inputVersion": "skill-selection-v1",
  "userRequest": "继续把这份报告导出为 PDF",
  "taskContext": "报告正文已完成，本轮需要导出",
  "skills": [
    {
      "id": "pdf-export",
      "description": "将完成的报告导出为 PDF",
      "bodyRef": "skill:pdf-export@r3",
      "modelInvocable": true
    }
  ],
  "explicitSkillIds": [],
  "catalogRevision": "r3",
  "complete": true
}
```

**判断：** 是否需要技能，以及各候选是否匹配当前动作。候选较多时，先按目录信息排序，再复核少量候选的完整说明或必要正文。官方示例提供“排名后复核”的参考，但其最多选择一个技能的限制不是本项目要求。[TypeSafe Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion)

**策略与结果：** 返回 `selectedSkillIds` 或空集合；支持多个技能。用户显式指定优先，但仍受技能可调用规则和可用性约束；强制指令不参与可选技能筛除。目录不完整、候选失效或判断失败时保留宿主原生选择流程。

**首版：** 在 shadow 中记录推荐，与 agent 实际加载和人工标注比较；apply 时注入推荐，保留原生目录和加载器。随后才评估自动加载或目录缩减。技能正文历史不会因下轮未选中而自动消失；严格按轮卸载需与 1 的投影和任务生命周期配合，不能仅依据新一轮短输入移除仍适用的技能。

**评估：** 按标注技能集合计算漏选、多选和完全匹配；分别统计无需技能的请求、相似技能、多技能任务、显式调用及“继续”请求。记录实际加载正文 token、全部判断请求成本、缓存影响、增加的延迟和任务成功率。两次判断的收益必须与其往返成本一起比较。

### 5.3 参数语义验证与有限映射：`argument-verification`

**目标：** 拦住类型正确却偏离用户意图的调用。默认先验证 agent 已提出的参数；有限函数映射作为独立扩展。

输入示例：

```json
{
  "task": "argument-verification",
  "inputVersion": "argument-verification-v1",
  "userRequest": "读取最近 7 天的测试环境日志",
  "functionId": "query_logs",
  "schemaRevision": "query-logs-v1",
  "parameterSpec": {
    "environment": { "type": "string", "enum": ["test", "production"] },
    "days": { "type": "integer", "minimum": 1, "maximum": 30 }
  },
  "proposedArguments": { "environment": "production", "days": 7 },
  "localValidation": { "schemaPassed": true, "crossFieldPassed": true },
  "complete": true
}
```

示例中的约束属于业务校验定义，不承诺 dsh 或 pi 的原生 schema 子集直接支持全部关键字；适配器必须核对支持范围并实现其余确定性检查。

**判断：** 函数是否匹配请求、每个实参是否有依据、缺失是否合理。参数依赖的信息要一并提供；不存在来源的自由值不能靠高概率补齐。

**策略与结果：** 只有类型/必填、范围/格式、跨字段约束、语义及宿主权限都满足才允许执行。返回 `pass / review / reject`，指出失败字段；review 不执行并走宿主支持的澄清或复核。判断绑定精确函数、最终参数快照和上下文；后续 handler 改参会使之前的验证失效，必须在最终执行边界确保一致或重新验证。

**首版：** 选少量可核对的工具做参数语义检查。复用 dsh `defineTool` 和 pi 参数 schema 的确定性校验，Jev 只补充语义判断；dsh pre-execute 保持拒绝并反馈的做法，不静默改写已记录的参数。需要在两宿主证明最终检查确实发生于副作用之前。

**有限映射：** 对明确注册的函数、枚举、布尔值和有限候选使用 Categorical/Binary，加入无匹配出口。自由文本、路径、数字和代码由解析器或生成模型先提供候选，再校验。官方函数调用示例的主要范围是封闭候选参数。[TypeSafe Function calling](https://docs.typesafe.ai/cookbooks/function_calling)

**评估：** 正确函数和完整参数组的匹配率、语义错误漏放率、正确调用误阻断率、复核比例及总延迟。覆盖未指定值、跨字段冲突、候选不覆盖、引用过期、后续改参和嵌套调用。无效或未通过验证的参数导致副作用的次数必须为零；逐字段正确率不能替代参数组合正确率。

### 5.4 字段验证与升级：`field-verification`

**目标：** 轻量抽取处理常见输入，验证器定位错误或不确定字段，策略决定是否交给推理模型重新处理。

输入示例：

```json
{
  "task": "field-verification",
  "inputVersion": "field-verification-v1",
  "source": {
    "id": "document-1",
    "text": "测试活动计划于 2026-10-12 开始。",
    "complete": true
  },
  "fieldSpecs": {
    "startDate": { "type": "string", "format": "date", "required": true }
  },
  "candidateRecord": { "startDate": "2026-10-21" },
  "evidence": { "startDate": ["document-1"] },
  "localValidation": { "schemaPassed": true },
  "complete": true
}
```

**判断：** 逐字段判断缺失、无来源支持、取错对象、矛盾及未满足语义约束；类型和格式由本地代码处理。证据引用必须实际匹配源文本，单有引用 ID 不算字段正确。

**策略与结果：** 输出 `accept / escalate / reject` 和待处理字段。任一关键字段存在错误、不确定或证据缺失，都不能被其他低风险字段的均值掩盖。升级后的记录重新执行确定性和必要的语义校验；设置重试上限，最终仍不确定的记录进入复核或拒绝，不循环生成直至“看起来通过”。[TypeSafe SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade)

**首版：** 由一个明确的抽取工具或 workflow 提供源文本、schema 和候选。不能只验证抽取器自己标为存疑的字段：固定检查关键字段和错误空值，其他字段的检查范围由经过评估的策略决定。已知可信的确定性来源可另设规则通道，但 schema 通过本身不足以跳过语义验证。

当前安全 judge 不负责字段正确性，routing 只选择模型配置，均不自动形成抽取重试流程。项目提供验证与升级决策，Extractor 和推理模型调用由工具或 workflow 编排。结果后处理也不能撤销此前已经产生的副作用。

**评估：** 字段正确性、自动接纳记录中的错误比例、自动接纳覆盖率、升级比例、推理后仍错误比例、总成本和端到端延迟。基线包括轻量模型单独抽取、推理模型单独抽取及级联。令 `q` 为升级比例：

```text
C_cascade = C_extract + C_verify + q × C_reason + C_recheck
```

计算使用实际计费并包含重试、复核和再次校验；只有在预先约定质量目标下取得净收益才继续扩大。历史[评估方法](eval.md)记录过官方直连单次判断约 20 s，属于当时测量，不是当前性能承诺；必须重新测量所选端点的 p50/p95 延迟。

### 5.5 经验候选与记忆升级：`memory-promotion`

**目标：** 从纠正与实际结果中提出有范围、可追溯的经验，再决定是否升级为跨会话记忆。候选文字由规则或生成模型提出，Jev 判断证据和适用性。

输入示例：

```json
{
  "task": "memory-promotion",
  "inputVersion": "memory-promotion-v1",
  "candidate": {
    "id": "lesson-1",
    "text": "在这个项目中，解析器修改需要保留 v1 日志恢复能力。",
    "scope": { "kind": "workspace", "id": "workspace-1" },
    "conditions": ["修改日志解析器"]
  },
  "correctionRefs": ["session-1:e17"],
  "actionRefs": ["session-1:call-4"],
  "outcomes": [{ "eventRef": "session-1:e23", "kind": "test", "status": "passed" }],
  "conflictingMemoryIds": [],
  "memoryRevision": "m4",
  "complete": true
}
```

**判断：** 是否有实际纠正证据、经验是否得到相关结果支持、适用范围是否过大、是否仅属于本任务、是否与已有记忆冲突。这些问题分别回答，不将 agent 自述“已经成功”视为独立结果证据。

**策略与结果：** 输出 `candidate / promote / discard`，绑定证据与范围；冲突或证据不足先留在候选区。一个任务的成功可以支持有限范围经验，不能证明全局规则普遍成立。显式用户偏好与由任务结果归纳的经验使用不同的证据规则，不要求前者必须由测试结果支持。

**首版：** 先离线候选和回放评估，暂不自动写入长期记忆。记录适用条件、反例和后续验证；达到写入条件后通过独立 `MemorySink` 适配存储。写前检查记忆版本和冲突，支持去重、修订及撤回。宿主权限由后端和宿主继续处理；不假定存在可直接依赖的统一官方 `ctx.memory`。

轨迹源需要覆盖恢复历史和嵌套工具执行；压缩后最终 messages 和当前判定审计都不足以作完整证据。pi 在 `agent_settled` 后开展可取消的后台整理；跨会话数据存储独立于单会话自定义 entry。[pi 存储与生命周期](https://pi.dev/docs/latest/extensions)

**评估：** 升级精确率、任务特定信息的误升级率、冲突识别、证据可解析率及后续任务的应用效果。按 workspace、任务类型和会话分组，避免同一经验的近似副本同时进入校准和验证集。先证明确实提高记忆准入质量，再验证后续任务收益。

## 6. 评估与推进关卡

沿用[现有评估方法](eval.md)的输入指纹、冻结策略、原始结果归档及 replay 思路，但为各任务建立独立 fixtures、标签和分析器。当前 guardrail 脚本不能未经扩展就承担新任务评估。

### G0：输入和结构正确

- 使用固定 fixtures 验证输入规范化、完整性标记、问题构造、答案校验和确定性 policy 回放。
- 依任务验证原文一致、工具配对、技能可调用规则、参数校验发生在副作用之前、字段证据及记忆引用。
- 覆盖缺失答案、超时、取消、并发、过期结果、恢复和分支。核心结构不变量必须全部通过。
- 构造 gold 标签与标注理由；不把当前模型输出反过来当作 gold。

### G1：冻结实验设计

- 在采集候选结果前定义原生或已有方案基线、主要质量指标、允许的质量变化范围、成本目标和延迟预算。
- 按原始会话、文档、任务或经验来源分组拆分 calibration 与 holdout；同一来源的变体和重复采样留在同一组。
- 固定 provider/实际模型、输入、问题、策略和隐私格式版本。只在 calibration 调参；独立 holdout 留作冻结后的验证。
- 记录样本数、任务分布、置信区间和错误案例。重复采样是稳定性观察，不是新增独立样本；已经查看的验证集如实标为已见。

指标目标尚未冻结时可以继续离线实现，不进入影响用户行为的默认应用。

### G2：shadow 与隔离应用实验

- Shadow 不阻塞宿主，不修改消息、选择结果或记忆；其数据用于观测覆盖、错误和资源成本。
- 原文筛选、技能推荐等会改变未来轨迹的任务，在隔离会话中进行成对应用实验；不能把 shadow 后的原生成功率当成新策略成功率。
- 实验尽量固定主模型、工具环境和任务条件，并报告重复波动。判断延迟、provider 费用、缓存变化和后台资源竞争计入总成本。
- 各任务质量与性能目标同时达标，才进入显式可选 apply。缩减目录、删除上下文或写入记忆等后续动作分别验证，不由推荐实验自动背书。

### G3：宿主接入与回退

- 对实际支持版本验证生命周期、取消、恢复、分支和原生权限，不仅测试模拟事件。
- 每个任务可独立启停；关闭后恢复原生流程。已提交持久投影或记忆需具备可解释的恢复、修订或撤回方案；关闭插件本身不等于撤销历史数据变化。
- 不兼容或缺少的宿主接口应明确标注、回退或提出上游变更，不宣称已支持。
- 每次启用、阈值变更或模型替换附完整评估报告和可回放证据。

## 7. 开发里程碑与待办

每个里程碑以对应关卡通过为结束条件。下面是计划，未完成项保持未勾选；后续 PR 更新实际状态、证据与适用版本。

| 里程碑           | 交付物                                                                | 前置条件与退出条件                                                 |
| ---------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| M0：最小共同基础 | 首个任务的输入/schema、构造器、纯策略、共享判断执行入口、必要审计身份 | G0；不提前构造通用抽取或记忆平台                                   |
| M1：技能推荐     | 独立 fixtures、shadow 结果、pi/dsh 推荐适配与报告                     | 与原生自选比较；G1–G3；推荐应用不能冒充 shadow                     |
| M2：原文保留     | 离线选择计划、pi 请求投影与持久化验证、dsh 投影设计                   | G0 的原文/依赖保护；任务成功与预算实验；dsh 接口不满足时不宣称接入 |
| M3：参数语义验证 | 少量工具的逐字段和组合检查、最终执行快照绑定                          | 本地校验和原生权限继续生效；失败无副作用；不扩展为通用代码生成     |
| M4：抽取级联     | 明确源数据/schema 的工作流、字段验证和有限升级、成本质量报告          | 先有代表性需求；比较三条基线；重新校验升级结果                     |
| M5：记忆准入     | 轨迹/outcome 证据源、候选经验评估、MemorySink 与修订能力              | 先离线候选；证据覆盖与升级精确率达标后才试持久应用                 |

首批可执行待办：

- [ ] 为 `skill-selection` 固化输入 schema、问题集、动作和失败回退。
- [ ] 建立原生技能自选的标注基线，覆盖无需技能、相似技能、多技能和显式调用。
- [ ] 为新增任务提供宿主无关的判断执行入口，统一能力检查、身份校验、超时和取消；保留既有接口兼容。
- [ ] 扩展审计身份与答案格式，记录拟议动作；需要衡量后续效果时补实际 outcome 关联。
- [ ] 先实现技能推荐 shadow，再进行独立隔离的推荐应用实验。
- [ ] 为 `context-retention` 准备具有原文、依赖与必保留标签的轨迹 fixtures。
- [ ] 验证 pi 持久投影和 dsh 原文保留契约，归档支持版本与缺口。

建议将共享任务构造器放在 `packages/decision/src/tasks/`，纯策略放在 `src/policy/`，通过 `kernel` 导出必要的宿主无关接口；dsh/pi 接入保持独立且按任务启用。目录是建议，首个实现先做最小增量。抽取器、生成模型和记忆后端按实际需求另接，不成为 Jev adapter 的职责。

## 8. 来源与后续更新

本地实现证据见第 2 节链接。外部调研只使用官方文档和上游源码；官方示例展示可行模式，不是本仓库的质量、成本或兼容性验证。

| 来源                                                                                                        | 支持的调研结论                             |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [TypeSafe Introduction](https://docs.typesafe.ai/introduction)                                              | 三类判断原语、原子问题与代码聚合           |
| [TypeSafe Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion)                            | 技能排名后复核模式；示例选择范围有限       |
| [TypeSafe Function calling](https://docs.typesafe.ai/cookbooks/function_calling)                            | 固定函数和封闭参数候选的映射               |
| [TypeSafe SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade)                                      | 逐字段验证、错误触发升级和成本质量比较     |
| [dsh Skills](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md)         | 技能目录、可调用规则、正文加载和目录完整性 |
| [dsh Session](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md)       | 原始事件日志、消息投影和回放               |
| [dsh Compaction](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/compaction.md) | 区间到摘要节点的压缩契约与工具配对         |
| [dsh Tools](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md)           | typed tool 定义、参数校验与执行边界        |
| [pi Skills](https://pi.dev/docs/latest/skills)                                                              | 目录展示与按需读取正文                     |
| [pi Extensions](https://pi.dev/docs/latest/extensions)                                                      | 上下文、工具、生命周期、存储和可写边界     |
| [pi Session format](https://pi.dev/docs/latest/session-format)                                              | 原始历史、分支及 `context_edit` 持久投影   |

每次迭代更新调研日期、实际宿主版本、里程碑状态、已验证/仍假设的结论以及报告链接。问题措辞、输入格式、出站脱敏或模型变化时重新采集判断；只有策略配置变化且输入/判断版本兼容时才直接离线回放。不得仅凭上游案例、一次成功或已见小样本将候选方向标为已验证。
