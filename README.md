# Claude Science Operator

Claude Science Operator is a Codex plugin for operating a locally installed Claude Science instance through CSSwitch.

It uses the version-gated local API for routine project and session work, and falls back to the macOS GUI when startup, authentication, approvals, uploads, downloads, exports, or artifact interaction require visible user interaction.

## Loop Engineering：把协作做成闭环

这套插件背后的工作方式是 **Loop Engineering**：人不是把任务丢给模型后等待结果，而是和两个不同职责的智能伙伴组成一个可观察、可纠偏、可停止的闭环。

![Loop Engineering：疯科学家将压力传递给 Codex，Codex 再传递给 Claude Science](docs/illustrations/loop-engineering-pressure.png)

这个闭环的重点不是“让模型不断干活”，而是让每一轮都产生可以判断的状态、证据和下一步选择：

1. **定向**：人定义目标、约束、成功标准，以及哪些动作必须先确认。
2. **编排**：Codex 澄清任务、选择合适工具和执行路径，并保留可追踪的上下文。
3. **执行**：Claude Science 处理适合它的研究与任务工作，遇到登录、上传、审批或不确定结果时停下来。
4. **检视**：Codex 汇总进度、结果和风险；人检查关键结论、工件与外部影响。
5. **决策**：继续下一轮、修正方向、接受结果，或明确停止。

![Loop Engineering：斯文猴在前景努力理解 Codex 与 Claude Science 的高压交谈](docs/illustrations/loop-engineering-listening.png)

### 角色边界

- **人**：拥有目标、授权、预算、风险判断和最终决定权。
- **Codex**：负责任务编排、状态汇总、工具协调、验证与安全停止。
- **Claude Science**：负责聚焦的研究、分析和执行；它不是最终授权者。

### 实践原则

- 每一轮都应留下可检查的工件、结论或状态，而不只是“已完成”的口头声明。
- 有外部影响的动作（登录、上传、付费、发信、审批、敏感数据传输）必须回到人来确认。
- 遇到不确定写入、兼容性变化或目标模糊时，宁可暂停澄清，也不假装已经安全完成。
- 好的循环会逐轮缩小不确定性；当收益不再覆盖成本时，应显式结束循环。

## Requirements

- macOS
- Claude Science `0.1.20`
- CSSwitch schema `4`
- Node.js

The API channel is enabled only when the Claude Science binary, running process, health state, and loopback port all match the supported compatibility contract.

## Install from GitHub

Add this repository as a Codex plugin marketplace, then install the plugin:

```bash
codex plugin marketplace add Xu-Zhangsheng/claude-science-operator --ref main
codex plugin add claude-science-operator@claude-science-operator
```

Start a new Codex task after installation so the new skill and MCP server are loaded.

## Install from the package

Download `claude-science-operator-0.1.0.zip` from the [GitHub Release](https://github.com/Xu-Zhangsheng/claude-science-operator/releases/latest), extract it into `~/plugins/`, and install it through a local marketplace entry. The archive contains the complete plugin directory, including its manifest, MCP server, skills, references, tests, and logo.

For normal online installation, the GitHub Marketplace method above is recommended.

## Repository layout

- `.agents/plugins/marketplace.json` — Codex marketplace catalog
- `plugins/claude-science-operator/.codex-plugin/plugin.json` — plugin manifest
- `plugins/claude-science-operator/.mcp.json` — MCP server configuration
- `plugins/claude-science-operator/scripts/server.mjs` — local operator server
- `plugins/claude-science-operator/scripts/server.test.mjs` — automated tests
- `plugins/claude-science-operator/skills/` — Codex skill instructions and references
- `plugins/claude-science-operator/assets/logo.png` — plugin icon
- `docs/illustrations/` — Loop Engineering manga illustrations

## Test

```bash
node --test plugins/claude-science-operator/scripts/server.test.mjs
```

## Safety

The operator communicates with Claude Science through loopback-only endpoints, validates the expected runtime version and CSSwitch schema, and does not expose local credentials. Writes use unique intent IDs; an uncertain write result is never automatically retried.
