# DeepSeek Harness 原生适配

## 适配对象与边界

本适配让 **DeepSeek Harness 作为操作者，控制本机 Claude Science / CSSwitch**，不是用 Claude Science 的私有 API 控制 Harness，也不是复刻 Science 界面。

仓库根目录提供零额外运行时依赖的 `dsh-claude-science-operator@0.1.5` Cordis bundle。继续复用两个原 operator 的控制源码；原 Codex manifest、Marketplace、MCP 配置保持不变。0.1.4 集中适配经本机静态契约审计的 Claude Science 0.1.52，并保留认证、确认、版本、单次写入与不确定性保护。

验证环境：macOS，DSH `0.2.0-rc.2`，Node.js 24+。包的 DSH peer dependency 固定为已验证版本，其他版本须重新验证，不要通过版本豁免强行加载。

Claude Science 私有 API 显式支持 `0.1.20`、`0.1.25`、`0.1.43`，并增加经[本机契约审计](<science-0152-compatibility.md>)的 `0.1.52` 核心操作；0.1.52 未核对的写入在认证/发送前拒绝，不代表所有专家与偏好变更均已验证。CSSwitch Science 配置 schema 仍须为 `4`。CSSwitch Operator 支持原有 external/native authenticated control record。未知版本、健康或端口不匹配仍拒绝私有 API。

## 官方开发依据

本适配以 DeepSeek 官网链接的 [官方开发文档](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/) 和 `deepseek-ai/deepseek-harness` 官方仓库为依据，不以第三方增强插件行为作为 SDK 契约。在线文档可能领先桌面版本；每项接口还须对照本机 `0.2.0-rc.2` 的 Inspect 和已发布实现。

- [工具编写契约](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-tool.md)：原生 `ctx.tools.register` 是生命周期托管注册。官方允许直接注册 raw JSON Schema 工具，但它们必须自行验证输入；本适配验证原始 schema，保留 SDK DSL 不表达的数值边界。
- [权限预设](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/permission-presets.md)：默认完全权限是 `danger-full-access + never`，不是 `danger-full-access + ask`。
- [审批契约](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/approval.md)：`never` 自动拒绝每个审批请求，不代表所有已获权限的普通操作都被拒绝。需审批时仍只接受 `allowed-once`。
- [官方 plugin_manager 实例](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/src/tools.ts)：每次通过 `ctx.sandboxPolicy.resolve({ session: exec.agent.session })` 获取发起会话的策略；已有完全权限无需再次升级，较低模式须单次批准。本包采用相同访问边界，不从模型参数、全局审批开关或历史调用推断权限。
- [打包与安装](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish.md)：bundle 声明 `dsh.bundle.patch`，通过官方插件管理器安装到 profile；不把手改清单、复制到 `node_modules` 当作升级方式。
- [生命周期与 HMR](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/06-composition-and-hmr.md)：代码热更新须由 HMR watcher 实际覆盖该文件。仅重新启用插件或收到配置 `applied`，不能证明执行的是新代码。

`SandboxMode` 自动隔离的是文件效果，不是所有网络、进程或应用操作。本包的本机应用准入是工具层的显式守卫；原 operator 的认证、版本、确认、指纹和禁止重试机制独立保留。

## 安装

### 使用本次生成的安装包

在 **Harness 插件管理的安装入口**填入 `.tgz` 的绝对路径，安装并启用 bundle `dsh-claude-science-operator`。安装管理器支持本地目录和 tarball，不需要把包发布到 npm。

源码打包后生成的 0.1.4 安装包路径（在实际生成和安装前，不代表已交付或已生效）：

```text
/Users/xuzhangsheng/Documents/DSH GitHub/claude-science-operator/dist/dsh-claude-science-operator-0.1.4.tgz
```

安装会改变当前 profile，并影响该 profile 下的所有会话。若让助手执行，可授权其使用 `plugin_manager` 安装上述本地包。适配工作本身不自动安装、不修改 profile、不重启正在运行的 Harness，也不启动或停止 Claude Science。

- `application: applied`：管理器已将变更应用到当前运行时。
- `application: restart-required`：保存后按提示重启 Harness。
- 失败或版本不兼容：检查诊断，不要自动添加版本豁免。

这是 Host-only bundle，没有 Client 脚本、前端构建、HMR watcher 或额外 Web 服务。

### 0.1.1 重复加载修复

`deepseek-harness-zh_pro@0.9.5` 会监听 profile 依赖变化，将纯 id/name 的简单 bundle patch 提前热挂载。随后 DSH 正式启用同一个 bundle 会再次注册工具，触发 `tool "claude_science_status" is already registered`。

0.1.1 在 bundle insert 行显式声明 `config: {}`，使旧版增强插件的简单 patch 解析器不抢先挂载；正式 DSH Loader 仍正常加载。修复没有改增强插件、工具名称、审批或应用控制逻辑。

从 0.1.0 升级时须先清除已经存在的 `include:dsh-zh:zh-dsh-claude-science-operator` 临时入口。当前 profile 的恢复操作是先停用正式 bundle，临时撤下该依赖声明，让增强插件完成热卸载；然后更新已校验的包元数据、恢复依赖，并通过官方管理器启用 bundle 与它的插件行。不能直接跳过重复注册错误。

如果 bundle 显示已启用但插件行仍为 disabled，使用 `plugin_manager` 的 `set_plugin` 启用 `include:dsh-claude-science-operator`。最终应只有一个正式入口，且 `fiberPhase: active`。

**历史故障记录，不是推荐安装步骤：**此前标准安装器因已有 Codex 多平台包下载超时而回滚了清单；当时校验本地包后补登记了 `file:./node_modules/dsh-claude-science-operator`，但没有同步锁文件。后续升级必须通过官方包管理流程协调状态；若该流程仍失败，报告实际安装错误，不能继续用手改清单或覆盖已安装代码宣称升级成功。

### 从源码生成包

```bash
npm run check
npm test
mkdir -p dist
npm pack --pack-destination dist
```

也可在安装入口填写源码目录的绝对路径。以 tarball 安装更便于固定版本和交付。适配代码尚未推送时，上游 GitHub 安装不会包含本地改动。

### 安装后验证

用 `cordis_inspect_list` 获取当前 Provider，再通过 `host / Config / listConfigs` 查询包名 `dsh-claude-science-operator`，确认插件处于活动状态。用 `host / Tool / listTools` 确认工具目录；如果 Agent preset 限制了工具可见性，检查 preset，而不是重复安装 MCP 版本。

让助手加载 `claude-science-operator` 或 `csswitch-operator` 技能，然后先调用对应的 status 工具。发起会话为 `danger-full-access` 时，沿用已授予的权限，不弹出审批。其他模式在用户批准该次本机访问后才检查运行时；未安装或未启动的应用报告兼容性问题，而不是自动启动。

较低模式配合 `never` 时，审批自动拒绝，返回 `APPROVAL_DENIED`，不发送本机请求。完全权限配合 `never` 是官方默认预设，不应要求用户反复改成 `ask`。0.1.1 的无条件审批与此冲突；0.1.2 根据每次调用的会话策略修正，拒绝结果不会被当成授权。

更新后必须核对实际工具描述、活动 fiber 和 status 调用，证明新代码已执行。未覆盖安装目录的代码 watcher 不能提供热更新；必要时遵循官方管理器和桌面应用的重启提示，不修改模块路径来规避加载缓存。

### 0.1.3 MCP 输出边界重构

直接复用原 server 会跳过 MCP stdio 的 JSON 编码。上游 `RuntimeInspector.inspect()` 正常返回的状态对象包含可选的 `undefined` 字段；原 MCP 会省略它们，但 Harness 的 lossless JSON 检查会拒绝原始 JavaScript 对象。

0.1.3 在原生工具返回前恢复 `JSON.stringify` / `JSON.parse` 的 MCP wire 边界，不改上游应用控制源码、不编造缺失状态、不放宽 Harness 校验。编码失败的读取返回脱敏错误；已发送写入的编码失败报告 `STATE_UNCERTAIN`，绝不重发。新增回归使用真实上游 `callTool` 构造状态返回，并覆盖日期、可选字段、非法编码、写入不确定性；真实 Harness 工具管线也验证含可选字段和日期的响应。

### 0.1.4 Science 0.1.52 核心兼容

已对照本机 0.1.52 打包的接口实现核对认证、CSRF、模型、项目请求、会话与评审模型偏好。原上游已实现正确的 POST nonce 流程；本次不杜撰认证分支，不改成 GET、不放宽 Origin/端口/健康保护。0.1.52 仅开放已核对的写入，未知版本和未审计操作仍在发送前拒绝。

模型目录保留脱敏后的失败/来源诊断，fallback 或 last-good 目录不得冒充当前模型可用。会话从服务响应回读保存的模型，不回显请求参数冒充切换结果；消息使用服务返回的分页起点。失败/取消不算成功回答，已发写入的坏 JSON 或缺失必需 ID 属于 `STATE_UNCERTAIN`。

验收前先保存偏好原值和来源。评审模型 `source: default` 不能用 PUT null 恢复相同来源；use-intent 未声明状态也没有公开撤销接口。仅在可严格恢复时测试全局偏好，不直接编辑应用数据库。静态审计和模拟回归不等于真实回答成功，最终验收必须走正式安装插件。

## 会话级 API：先配置确认，再发送

0.1.5 新增 `claude_science_session_config`，不是全局 preferences 的替代命名。对已有根会话，可先 GET 记录显式存储基线，再以 `confirm: true` SET 以下支持项，工具自动执行独立 GET 回读：

```json
{"verifier_mode":"on","memory_mode":"off","reviewer_model":null}
```

这分别对应 Auto-review On、Memory Off、Reviewer Default（继承，全局评审覆盖仍可能生效）。POST 回显不算确认；未知来源、缺失字段、错误根身份或失配不算成功。续写可使用根绑定 `expected_session_config: {"frame_id":"目标根ID","config":{...}}`，工具在发送前再次读取验证。

模型、`effort: "max"` 与 `ultra_mode: false`（Delegation Off）属于一次发送的显式参数，不能声称由 session-config 预先持久化。旧 root `model` 列不是续写 current model；运行时 context 来源和初始显示列分别报告。Specialist / Compute Local 没有经过认证的完整预配置接口，当前不开放、更不以 GPU Off 冒充 Local。[详细会话契约与限制](<science-0152-session-config.md>)。

## 工具目录

### Claude Science：13 个

| 工具 | 用途 |
| --- | --- |
| `claude_science_status` | 检查运行时、版本、健康和 API 兼容性 |
| `claude_science_list_projects` | 分页列出项目 |
| `claude_science_list_sessions` | 列出指定项目的根会话 |
| `claude_science_submit_task` | 创建项目或向指定项目提交任务 |
| `claude_science_continue_session` | 向根会话提交一次后续任务 |
| `claude_science_poll_session` | 有界等待并读取会话进展、消息、审批与结果 |
| `claude_science_list_artifacts` | 读取工件元数据，不绕过 GUI 下载 |
| `claude_science_list_experts` | 列出专家配置 |
| `claude_science_expert_action` | 管理专家、提示词、技能和连接器 |
| `claude_science_list_models` | 读取当前模型目录 |
| `claude_science_settings` | 读取或修改原有显式设置白名单 |
| `claude_science_session_config` | 现有根会话的三项配置、独立回读与发送前确认 |
| `claude_science_safari_page` | 精确定位、聚焦、快照、点击或填充 Safari 项目页 |

### CSSwitch：7 个

| 工具 | 用途 |
| --- | --- |
| `csswitch_status` | 读取运行时状态 |
| `csswitch_capabilities` | 读取桥接支持的能力 |
| `csswitch_get_config` | 读取脱敏配置和写入所需的指纹 |
| `csswitch_list_templates` | 列出配置模板 |
| `csswitch_check_provider` | 本地链路检查；端到端检查需额外确认 |
| `csswitch_runtime_action` | 启停、模式、端口、SSH 复用 |
| `csswitch_profile_action` | 管理 profile 和模型目录；DSH 不接受 `key` |

工具名称与原 operator 一致，技能按相同名称原生注册。不要在同一 profile 中重复加载同名 MCP 工具。

## Harness 原生安全机制

1. **每次解析当前会话权限**：发起会话已有 `danger-full-access` 授权时直接沿用；其他模式，包括读取，须取得单次 `allowed-once`。拒绝、取消、无人应答或非标准结果都不发送本机请求。不缓存授权，不修改会话权限，也不把 `never` 单独当作授权。
2. **不伪造确认**：Harness 审批与原工具的 `confirm: true`、配置指纹守卫相互独立。审批通过也不会替调用者补齐 `confirm` 或指纹。
3. **参数先验证**：拒绝额外参数、错误动作和越界值；DSH schema 不支持的 numeric bounds 变为描述，但原始约束仍在 dispatch 前校验。
4. **跨 Agent 串行执行**：同一 bundle 的调用排队，防止 Safari 操作和运行时写入相互干扰。失败不破坏后续队列；轮到已取消调用时不执行。
5. **写入只发送一次**：保留唯一 intent id 和原有 `STATE_UNCERTAIN` 语义。取消前未发送的请求不执行；已发送的请求等待收尾，不通过抢先返回造成后台重复写入。写操作在取消后完成时报告 `STATE_UNCERTAIN`，先检查对象，再由用户决定是否重复。
6. **保留模型可见数据**：原 MCP 的 text 和 `structuredContent` 都渲染到 DSH 工具输出，项目/会话/意图 ID 不会因转换丢失。错误抛给 Harness 注册表，不将失败伪装成成功值。
7. **不接收密钥**：DSH 会在 dispatch 前持久化原始工具参数。DSH 版 schema 不暴露 profile `key`，执行层也拒绝它；必须在 CSSwitch UI 输入密钥。拒绝不能撤销已经进入会话日志的误传参数，所以不要把任何密钥交给模型工具。
8. **生命周期托管**：工具和技能使用 Cordis Service 注册效果；停用或卸载时自动注销，不留下 stdio 进程。

原 operator 自带的安全读取重试保持不变；适配层不添加任何重试。底层超时和响应大小限制同样保持不变。

## GUI 能力

Safari 精确控制依赖 macOS Automation 权限和 Safari 的 JavaScript from Apple Events 设置。插件不会自动授予这些权限。Safari 工具不控制 Harness 的嵌入式浏览器。

本包不包含 Computer Use provider。若当前 Harness 缺少合适的 GUI 工具，让用户完成登录、CAPTCHA、审批、文件选择、敏感上传、下载或导出；不要把“可选 GUI 回退”误报为已有能力。

## 测试

```bash
npm run check
npm test
```

普通 Node：177 项回归测试，3 项可选集成/兼容性测试因未指定安装目录跳过。测试覆盖原 operator 的 loopback 认证、版本/端口校验、cookie/CSRF、响应限制、脱敏、精确 Safari 匹配、指纹与单次写入，以及 Harness 注册、审批、参数、输出、取消、排队和密钥边界。

对本机 macOS 桌面应用的真实 Cordis / Tools / Skills 服务进行集成验证：

```bash
ELECTRON_RUN_AS_NODE=1 \
DSH_TEST_RUNTIME_ROOT='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh' \
DSH_TEST_ZH_HOT_MOUNT="$HOME/.dsh/profiles/desktop/node_modules/deepseek-harness-zh_pro/lib/hot-mount.js" \
'/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' \
--test test/runtime-integration.test.mjs
```

该集成验证使用临时 Context，不改变 profile，也不访问实际 Claude Science/CSSwitch。它检查全部工具 schema、20 个工具与 2 个技能的真实挂载、审批拒绝、真实工具输出管线及卸载注销。另在隔离 VM 内运行已安装增强插件的纯 patch 解析器，验证 0.1.0 会被提前挂载而 0.1.1 不会；不执行增强插件的副作用代码。0.1.4 的三项可选测试均通过，与普通回归合计 180 项通过、0 失败、0 跳过。新增 0.1.52 合成 HTTP 与契约 fixtures 覆盖版本/写入门禁、认证边界、目录诊断、实际模型投影、消息分页以及发送后坏响应的不确定性；它们不等于实际应用/provider 验收。新增回归涵盖完全权限不触发审批、权限降级不复用旧授权、完全权限不伪造写入确认，以及未知模式仍须审批。真实集成 Context 还挂载官方 SandboxPolicy 与 SessionProjection 服务。

0.1.5 在实际安装的 Harness SDK 上全量运行 **283 项通过、0 失败、0 跳过**（普通回归 280 项 + 3 项真实运行时集成）。新增会话独立合成回归 85 项，核心 HTTP 114 项；它们证明参数映射、独立回读、错误边界及一次写入流程，不是实际配置/provider 验收。

0.1.4 已正式安装，真实 API 小消息、分开选择 Sol/Luna、全局 reviewer 改回和精确 Safari 读/点击已有过程证据。新 0.1.5 会话 API 的实际修改/恢复及带配置守卫的回答仍须正式升级后另验。未运行真实研究任务、修改 CSSwitch 配置或测试登录/上传/导出；也不把浏览器草稿、请求 echo、合成测试当模型最终供应商路由证明。
