# @techs/dsh-decision

把类型化 Judgment 与确定性 Policy 接入 [dsh](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）作为**决策层**。
[Jev](https://jev-ai.pro)（TypeSafe System One）是第一个 provider；架构 provider 无关——后续同类模型
新增一个 `packages/decision-<name>` 包即可，核心零改动。

v1 设计见 [design.md](design.md)，v2 的审查结论与实施顺序见 [v2-plan.md](v2-plan.md)。

## 四个切面

| 切面      | dsh 事件             | 决策                                                              | 默认   |
| --------- | -------------------- | ----------------------------------------------------------------- | ------ |
| Guardrail | `tools/pre-execute`  | 一次评估六维风险，逐维阈值决定 allow/review/deny；review 交给人工 | **开** |
| Routing   | `agent/request`      | 从当前 step 接纳的消息选择模型档位，低置信度保留原选型            | 关     |
| Judge     | `tools/post-execute` | 结果含 prompt injection / 暴露密件则 block 并换成纠正性反馈       | 关     |
| 机审      | `approval/request`   | 仅 `permission: machine` 接管原生审批；未获资格的高分判断交给人工 | 关     |

`permission`（`native | machine`）与 `enforcement`（`shadow | enforce`）正交。默认 `native + shadow`；shadow 中决策模型在旁路运行，原生决策链立即继续。DSH 的 Auto 与 Full Access 仍由其原生权限预设管理，本插件不切换 sandbox 或审批策略。Guardrail/Judge 是独立的策略切面，若在 `enforce` 下启用，仍可能限制原生 Full Access。

## 仓库结构

```
packages/decision/       # 核心包 @techs/dsh-decision（服务 + 四切面，无任何 provider）
packages/decision-jev/   # Jev adapter 包 @techs/dsh-decision-jev（systemone wire 客户端）
profile/                 # dsh profile 层：dsh-base + 两行插件，软链到 ~/.dsh/profiles/decision
```

```sh
pnpm install
pnpm run build      # 两个包 tsc 构建（profile 以 file: 依赖消费 lib/）
pnpm run test       # vitest（决策纯函数 + wire 映射）
pnpm run lint       # oxlint
pnpm run fmt        # oxfmt --check
```

## 接入 dsh

1. 构建：`pnpm run build`
2. 软链 profile：`ln -s ~/codes/dsh-decision/profile ~/.dsh/profiles/decision`
3. 初始化 profile 依赖（在 profile 目录）：
   ```sh
   cd ~/.dsh/profiles/decision && pnpm install
   ```
4. 配 key：jev-ai.pro 生成 API key 后 `export JEV_API_KEY=...`（或改 `profile/cordis.patch.yml`）
5. 冒烟（shadow 模式，观察 `decision shadow:` 日志）：
   ```sh
   pnpm dsh --profile decision "列出本目录文件并统计行数"
   ```
6. 观察一段时间后把 `profile/cordis.patch.yml` 的 `enforcement: shadow` 改为 `enforce`。

要加进现有 profile 而不是独立 profile，也可以在上游源码树里：
`pnpm dsh plugin --profile <name> add ./packages/decision`（两个包分别 add）。

## 配置速览（profile/cordis.patch.yml）

```yaml
- id: decision
  name: "@techs/dsh-decision"
  config:
    provider: jev
    permission: machine # native | machine；DSH Auto/Full Access 由 DSH 自身控制
    enforcement: shadow # shadow | enforce；旧 mode 字段仍可用
    guardrail:
      enabled: true
      onFailure: allow
      risks:
        secretExposure: { reviewAt: 0.15, denyAt: 0.70 }
        destructive: { reviewAt: 0.35, denyAt: 0.85 }
    machine: { uncertain: human } # human | deny
    routing: { enabled: false, confidenceFloor: 0.6, routes: [...] } # provider/model 必须自己配
    judge: { enabled: false, blockAt: 0.75 }
    approval: { allowAt: 0.85, rejectBelow: 0.5 }
- id: decision-jev
  name: "@techs/dsh-decision-jev"
  config:
    apiKeyEnv: JEV_API_KEY
    # baseUrl: https://api.typesafe.ai   # 切 TypeSafe 官方端点
```

关键安全取舍（详见 v2-plan.md）：adapter 调用失败时 guardrail 默认放行（可配 `ask`/`deny`）、
审批失败按 `machine.uncertain` 委托人工或拒绝。Jev provider 当前没有 `provider + model + approval + policyVersion` 的自动放行资格，因此默认不能自动批准；发给外部 API 的 state 仍可能包含原始工具参数，脱敏属于后续阶段。上述风险阈值是实验值，不代表已校准。

## 写新 provider

实现 `@techs/dsh-decision` 导出的 `JudgmentProvider`（Binary/Categorical/Ordinal）并注册：

```ts
export const inject = ["decision"];
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.decision.registerProvider(provider));
}
```

`@techs/dsh-decision-jev/src` 是参考实现。旧 `DecisionAdapter` 仍可通过 `registerAdapter()` 注册，兼容层会把新问题映射到 Noul/Choice/Score；旧的 `calibrated` 布尔值不授予 v2 自动放行资格。
