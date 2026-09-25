# @techs/dsh-decision

把概率型决策模型接入 [dsh](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）作为**决策层**。
[Jev](https://jev-ai.pro)（TypeSafe System One）是第一个 adapter；架构 provider 无关——后续同类模型
新增一个 `packages/decision-<name>` 包即可，核心零改动。

设计决策见 [design.md](design.md)。

## 四个切面

| 切面      | dsh 事件             | 决策                                                                                                   | 默认   |
| --------- | -------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| Guardrail | `tools/pre-execute`  | 每次工具调用前问两个 Noul（harmful/exposure），风险 `≥denyAt` 拒绝、`<allowBelow` 放行、中间转人工审批 | **开** |
| Routing   | `agent/request`      | Choice 选模型档位，confidence 低于阈值回退默认选型                                                     | 关     |
| Judge     | `tools/post-execute` | 结果含 prompt injection / 暴露密件则 block 并换成纠正性反馈                                            | 关     |
| 机审      | `approval/request`   | P(allow) 高于阈值自动 `allowed-once`；uncalibrated adapter 永不自动放行                                | 关     |

所有切面默认 `mode: shadow`：照常调用决策模型并记录日志，但一律放行——先观察判断质量再切 `enforce`。

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
2. 软链 profile：`ln -s ~/codes/open/dsh-decision/profile ~/.dsh/profiles/decision`
3. 初始化 profile 依赖（在 profile 目录）：
   ```sh
   cd ~/.dsh/profiles/decision && pnpm install
   ```
4. 配 key：jev-ai.pro 生成 API key 后 `export JEV_API_KEY=...`（或改 `profile/cordis.patch.yml`）
5. 冒烟（shadow 模式，观察 `decision shadow:` 日志）：
   ```sh
   pnpm dsh --profile decision "列出本目录文件并统计行数"
   ```
6. 观察一段时间后把 `profile/cordis.patch.yml` 的 `mode: shadow` 改为 `enforce`。

要加进现有 profile 而不是独立 profile，也可以在上游源码树里：
`pnpm dsh plugin --profile <name> add ./packages/decision`（两个包分别 add）。

## 配置速览（profile/cordis.patch.yml）

```yaml
- id: decision
  name: "@techs/dsh-decision"
  config:
    provider: jev # 选哪个已注册 adapter
    mode: shadow # shadow | enforce
    guardrail: { enabled: true, allowBelow: 0.2, denyAt: 0.7, onFailure: allow }
    routing: { enabled: false, confidenceFloor: 0.6, routes: [...] } # provider/model 必须自己配
    judge: { enabled: false, blockAt: 0.75 }
    approval: { enabled: false, allowAt: 0.85, rejectBelow: 0.5 }
- id: decision-jev
  name: "@techs/dsh-decision-jev"
  config:
    apiKeyEnv: JEV_API_KEY
    # baseUrl: https://api.typesafe.ai   # 切 TypeSafe 官方端点
```

关键安全取舍（详见 design.md）：adapter 调用失败时 guardrail 默认放行（可配 `ask`/`deny`）、
审批失败一律委托人工、非校准 adapter 不能自动放行审批、发给外部 API 的 state 最小化。

## 写新 adapter

实现 `@techs/dsh-decision` 导出的 `DecisionAdapter`（`{ id, calibrated, evaluate(request) }`，
Noul/Choice/Score 三种问题原语），在自己的插件包里：

```ts
export const inject = ["decision"];
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.decision.registerAdapter({ id: "my-model", calibrated: false, evaluate }));
}
```

`@techs/dsh-decision-jev/src` 是完整参考实现。
