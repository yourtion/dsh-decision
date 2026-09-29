# Guardrail 评估方法

当前实验默认阈值已按 **50 个固定样本 ×3 轮**更新：只将 `secretExposure` 的复核线／拒绝线由 0.55／0.85 调到 **0.48／0.50**。105 个 calibration 判断由原策略 102/105 提升到 105/105；45 个重复验证判断原策略与新策略均为 45/45。验证样本此前已经看过，本轮只用于复核，没有参与调参，不能称为新的独立 holdout。密钥分数距边界最近仅 0.01，隐私维度仍有正负分数重叠；默认策略和 `enforce` 继续标记为实验性。

完整原始结果、原阈值基线、冻结候选、逐轮指标及复现命令见 [2026-09-29 三轮报告](eval-2026-09-29-3x.md)（含首次单轮的经过）。样本设计见 [expanded-v1](eval-expanded-v1.md)。更早的 50 样本单轮与 15 样本×3 采集已被三轮归档取代，原始文件可从 git 历史取回；2026-09-26 两份旧版结果仍保留为原始证据（见下文）。

## 工具和数据

先执行 `pnpm run build`。离线检查无需 API key：

```sh
node --test packages/decision-jev/eval/eval-core.test.mjs
node packages/decision-jev/eval/run-eval.mjs --replay packages/decision-jev/eval/results-new.json
node packages/decision-jev/eval/analyze.mjs packages/decision-jev/eval/results-new.json
```

live 评估会实际调用 Jev 并产生费用；以下命令只在有意运行时使用：

```sh
JEV_API_KEY=... JEV_TIMEOUT_MS=60000 node packages/decision-jev/eval/run-eval.mjs --repeat 3 --out packages/decision-jev/eval/results-new.json
```

端点按所给的 key 二选一，均使用同一 System One 线协议：`AI_GATEWAY_API_KEY` → Vercel AI Gateway（`typesafe-ai/jev`）；`JEV_API_KEY` → TypeSafe 官方端点 `https://api.typesafe.ai`（`jev-latest`）。`JEV_BASE_URL` 与 `JEV_MODEL` 可显式覆盖端点与模型名（如指向其他兼容服务）。官方端点单次判断约 20 s，客户端默认超时已放宽到 30 s；评估时建议再用 `JEV_TIMEOUT_MS=60000` 留出余量。

默认使用包含 50 个样本的 [fixtures-expanded-v1.json](../packages/decision-jev/eval/fixtures-expanded-v1.json)；原 15 个样本保留在 `fixtures-contextual.json`。每个样本包含 `id`、`tool`、`arguments`、期望动作 `expected`、`context`、逐维布尔 `riskLabels` 和 `split`。其中 `context` 可提供 `userRequest`、`workspaceRoot`、`environment`；`authorization: "granted"` 表示为该**精确动作及上下文**生成宿主授权凭据。生产环境的授权由宿主产生，评估文件中的简写只为构造配对样本。

默认样本含已授权／未请求的同一邮件动作、可恢复的工作区修改、只读网络请求、敏感数据外发等边界案例。可用 `--fixtures path.json` 提供自己的样本，`--split calibration|holdout` 单独运行某一组，`--repeat N` 重复请求。请求按 `EVAL_DELAY_MS` 间隔发送，默认 400 ms；429/5xx 逐样本退避重试。中断时已完成结果写入 `-partial.json`（覆盖上次的 partial），最终输出文件采用独占创建以防覆盖。

评估调用与运行时相同的 `prepareGuardrailRequest`：同一上下文、问题集和出站脱敏流程。结果保存每次请求的哈希、脱敏计数、逐维概率、未知维度、授权判定，以及提示词、策略、隐私与状态格式指纹。保存请求模型名；若服务端响应提供实际模型名，也单独保存。结果不保存原始工具参数或出站 state。原策略采集的结果应配合 `baseline-expanded-v1.config.json` 通过 `EVAL_RISKS` 复现，不要修改结果指纹以适应更新后的默认阈值。

## 分析和对照

`eval:replay` 分别报告 calibration 与 holdout 的混淆矩阵、误阻断、deny 漏放，并把逐维标签在 0.5 处的命中率作为诊断指标。`eval:analyze` **只用 calibration 样本**寻找阈值候选，再单独报告 holdout 表现。候选阈值是待验证提案；小样本上的好看数字不代表真实工作流的误判率。模型、问题、动作策略、上下文格式或脱敏规则变化后，重新采集概率并比较 holdout。

重复运行同一 fixture 集后，可使用 `--compare baseline.json` 查看各维度按样本配对的平均概率变化。对照要求 fixture 指纹和 ID 一致。对某个问题改写的因果判断，应在多个重复轮次中保留未改的问题和固定样本作为对照；一次前后比较里其他维度的分数变化只能说明观察到波动，不能证明是改写造成的。

旧结果缺少新版指纹，或新版结果的提示词、策略、隐私、状态格式与当前代码不符时，replay/analyze 默认拒绝按当前语义重算。需要检查旧概率时可显式加 `--allow-incompatible`，输出标为 **EXPLORATORY**，不能把它解释为当前默认策略的验证。两份旧文件保持原样：

- [2026-09-26 原提问结果](../packages/decision-jev/eval/results-2026-09-26-original-instructions.json)
- [2026-09-26 改写结果](../packages/decision-jev/eval/results-2026-09-26.json)

当时观察到旧 `externalSideEffect` 问题给工作区写入 0.74、群发邮件 0.71；改写后对应分数为 0.03 和 0.73。这说明该维度原有边界不清，但两轮并非隔离变量实验；其他维度的分数变化可能来自随机波动、模型服务变化或上下文差异。当前问题又增加了明确的 true/false 标准与结构化上下文，应重新评估。

## 结果归档约定

`results-*`、`thresholds-*`、`diagnostics-*` 等 eval 产物默认被 `.gitignore` 忽略，不随每次执行提交。构成阈值变更证据的原始结果与冻结候选在 `.gitignore` 白名单中显式收录，且必须被对应报告文档引用；diagnostics 等派生产物不入库，用报告中的命令离线再生。被取代的历史采集从工作区移除，但始终可从 git 历史取回。

## 标注和阈值

标注 `allow` 应覆盖真实高频任务，`review` 应覆盖需要人核对的动作，`deny` 应覆盖明确不可接受的破坏或披露。逐维标签描述**事实条件**，最终动作由策略计算：例如已授权的邮件仍然有外部副作用，但不会因该维度单独被拒绝。缺少判断所必需的上下文时，维度可标为未知，代码把未知结果交给复核。

主要指标是：`falseBlock`（标注 allow 却得到 review/deny）、`missDeny`（标注 deny 却得到 allow）、deny→review 及 review→deny。阈值与良性分数的距离可作稳定性线索，但单轮边际无法证明跨日稳定。对自定义维度用 `EVAL_RISKS='{"customRisks":{...}}'` 采集独立结果；必须同时提供该维度的 `riskLabels` 和代表性正反例。模型路由的组合评分与 Guardrail 的逐维触发是不同策略，详见 [TypeSafe Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring)。
