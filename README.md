# ZJT Workflow

Next.js + TypeScript + App Router + Tailwind CSS 应用。

## 本地开发

需要 Node.js >= 20.9.0，推荐使用 `.nvmrc` 中的版本。

```sh
nvm use
pnpm install
pnpm dev
```

打开 http://localhost:16080，编辑 `src/app/page.tsx` 即可实时预览。

## 常用命令

```sh
pnpm lint       # ESLint 检查
pnpm typecheck  # TypeScript 检查
pnpm build      # 构建生产版本
pnpm start      # 启动生产版本（需要先构建）
```

`src/app/` 存放页面与 API 路由，`@/` 指向 `src/`。
健康检查接口为 `/api/health`。

也可以通过 Makefile 调用已有脚本：

```sh
make              # 查看命令帮助
make install      # 安装依赖；CI 使用 make ci 锁定依赖版本
make dev          # 重启本项目开发服务，端口 16080
make check        # 依次执行 lint、typecheck、test、build，失败即停止
make start        # 启动生产服务，需要先 make build
make test-api     # 验证实际接口，需要先启动服务
```

`make lint`、`make typecheck`、`make test` 和 `make build` 可单独运行。
启动、检查、测试和构建命令在缺少本地 Next.js 依赖时，会先按
`pnpm-lock.yaml` 自动安装依赖，安装失败则停止，不继续启动。
`make dev` 会先停止占用 `16080` 的本项目旧进程，等待端口释放后再启动；
若端口属于其他目录下的项目，会报错停止，不自动结束其他项目的进程。
接口测试默认访问 `http://localhost:16080`，可通过
`NODE_API_BASE_URL=http://localhost:其他端口 make test-api` 覆盖。

## 独立节点接口

已迁入 21 个 FastGPT 节点处理函数，每个都有独立 `POST /api/workflow/nodes/<节点名>`。
仅供本地函数调用，不运行完整工作流，不代理回原 Fastify 服务。

```sh
curl -X POST http://localhost:16080/api/workflow/nodes/textEditor \
  -H 'content-type: application/json' \
  --data '{"params":{"system_textareaInput":"Hello {{name}}"},"variables":{"name":"ZJT"}}'

pnpm test          # 全部单元/路由测试，不要求服务运行
pnpm test:api      # 服务启动后，实际验证 21 个独立接口及缺失运行时分支
```

函数放在 `src/server/workflow-nodes/vendor/`，来源和校验值见同模块 `manifest.json`；
`adapters/` 只适配尚未迁入的外部能力。完整接口清单、参数和限制见
[迁移设计](.codex/design/workflow-node-function-migration.md)。

重新从来源仓库机械提取快照：

```sh
pnpm migrate:nodes --source=/absolute/path/to/workflow-zjt
# 或使用 Makefile，SOURCE 必须显式指定：
make migrate-nodes SOURCE=/absolute/path/to/workflow-zjt
```

运行不依赖来源仓库。子工作流引擎、存储签名和密文解密未迁入，触及这些分支时返回 HTTP 501。

## 模型配置

首页与 `/models` 提供模型配置：服务商预设、自定义 Model ID、编辑、启停、
每种类型的默认模型、回收站恢复及显式连通性测试。`/nodes` 列出独立节点接口。

将 `.env.example` 中 MongoDB 项配置到本地 `.env.local`。
模型 API Key 按当前需求以明文保存，不再依赖加密密钥。
真实账号密码及 API Key 不能提交 Git，也不能使用 `NEXT_PUBLIC_` 环境变量。

存储使用 `workflow16080_models`、`workflow16080_credentials`、
`workflow16080_settings`，不读取或覆盖库内其他业务集合。凭据保存在
`workflow16080_credentials.apiKey` 明文字段；前端只收到是否配置凭据，不收到 API Key。
数据库读取权限可直接读取全部模型密钥，数据库及备份应严格限制访问。
默认模型集中存储在单条 settings 文档中，不要求 MongoDB 副本集。
本版为单实例本地工具，同一进程中的写操作串行化；多实例部署需要补充跨实例并发控制和登录鉴权。

`pnpm dev`、`pnpm start` 仅绑定 `127.0.0.1:16080`，模型接口另外校验本地 Host、
同源 Origin 和代理头。不要直接把未鉴权的本地管理服务开放到公网。
MongoDB 默认不启用 TLS；跨公网使用应配置有效证书并设置 `MONGODB_TLS=true`，
或者使用 SSH 隧道与数据库网络白名单。代码不会绕过证书验证。

服务商目录只是可编辑的地址/模型示例，不会自动拉取模型目录。当前实现 OpenAI 兼容
和 Anthropic Messages 协议，不包含 AWS 签名、AIProxy 渠道、计费或监控。
连通性测试仅在勾选费用提示并点击开始测试后发出真实请求；不在保存、刷新时调用上游。
仅允许443端口HTTPS与公共地址，拒绝内网、重定向和超大响应。
语音识别配置可保存，但测试暂不提供音频上传。
配置页不会自动接入尚未迁移的AI工作流节点或完整调度引擎。

API：`GET/POST/PUT/PATCH /api/models`，`POST /api/models/test`。
配置修改需要携带 `id` 和 `revision`；测试还需 `confirmed: true`。
服务商图标复用来源项目 `fastgpt-plugin/modules/model/channelAvatar` 的对应资源。

服务运行后执行 `pnpm test:models` 可验证真实MongoDB读写、明文存储、接口不回传密钥、冲突、默认模型、
回收站及恢复。脚本只操作自己创建的随机标识记录，并在结束时清理；不会发送真实模型请求。

### 旧凭据迁移

已有 AES-256-GCM 密文需要使用原 `.env.local` 中的 `MODEL_CREDENTIAL_KEY` 迁移。
该变量只用于迁移，不参与新凭据的读写。迁移前应暂停配置写入并做好数据库备份。

```sh
pnpm migrate:model-credentials          # 预检查，不写入
pnpm migrate:model-credentials --apply  # 写入 apiKey 并移除旧 secret 字段
```

脚本先验证全部旧凭据，再逐条以旧值为条件更新，支持重跑，不输出密钥。
只处理 `workflow16080_credentials`，不改模型配置、默认模型或其他业务集合。

## 文件、文本、审核与模型节点

16080 新增 38 个独立节点，连同原有节点共 59 个。完整路由、参数、配置、调用示例和测试方法见[接口清单](docs/capabilities.md)。运行中的服务通过 `GET /api/capabilities` 提供新增节点的参数 Schema。

## Skill 管理

工作区侧栏的「Skill 管理」打开 `/skills`。支持手工创建、复制、删除，编辑 SKILL.md 与附属资源，导入历史单 Skill 或多目录 ZIP 包，发布版本、切换生效版本并分别导出草稿或发布包。以压缩及解压后各 50 MiB 为包上限。

模型试跑将所选草稿或发布版本的 SKILL.md 与测试输入发送给选定的语言模型。试跑仅在点击开始后发起，按所选供应商计费。资源脚本不参与执行。

Skill 元数据由 `workflow16080_skills` 集合保存，试跑的模型、版本及请求标识记录于 `workflow16080_skill_trials`。ZIP 包位于 `.workflow-data/skills`，可通过 `WORKFLOW_SKILL_DIR` 指定持久目录。备份或搬迁时应同时保留 MongoDB 数据和包目录。

## 本机 Shell

侧栏「Shell 控制台」打开 `/shell`，可切换执行模式、运行命令、批准或拒绝待执行命令、取消任务并查看日志。

| 模式 | 行为 |
| --- | --- |
| `isolated-shell`（默认） | 沿用 `just-bash` 虚拟工作区，不启动宿主机 Shell |
| `host-shell` | 运行真实 `/bin/sh -c`；只有固定的 `pwd`、`whoami`、`uname` 诊断命令免审批，其他命令均需批准本次执行 |
| `danger-full-access` | 真实本机执行，不再逐条确认命令；启用时需在本地界面确认一次风险 |

本机执行不是操作系统沙箱，工作目录也不是文件访问边界。命令具有服务进程系统账号的权限，可以访问该账号能访问的文件、网络和凭据。完全访问模式可能直接删除文件、安装程序、推送或部署。不要把本服务开放公网，不要向不可信调用方提供本地接口。子进程不继承数据库密码、模型密钥、HOME 或 Shell 启动钩子；这不能阻止已获授权的任意命令主动读取磁盘上的凭据。

Agent 显式传 `selectedTools: ["host_shell"]` 后可使用真实本机工具；服务端必须已经切换到本机模式。原 `sandbox_shell`、沙箱文件工具和 Skill 工作区不变，仍是虚拟路径。`host_shell` 的 `cwd` 必须是本机绝对路径；省略时使用控制台保存的工作目录。虚拟 `/workspace` 不会自动映射到本机。工具参数不能更改权限或批准自身。

审批模式下，Agent 状态为 `waiting_approval`，`pendingApproval.executionId` 对应控制台中的审批记录。批准或拒绝后查询运行接口会继续调度；批准接口也会触发调度。不使用 `resumeAgent` 的用户追问回答来授权命令。命令、目录、超时及模式版本不可替换；模式/目录变化使旧审批失效，批准有效期为15分钟。请求重放复用原结果，不会再次执行。结果不明确的中断任务不得自动重跑。

超时最长120秒（隔离模式60秒），每个本机进程 stdout/stderr 各限制256 KiB，同一服务进程最多并发2个任务。超时、取消或权限改变会终止原进程组；主动逃逸进程组的程序不在这一机制的隔离保证范围内。

`WORKFLOW_HOST_SHELL_DISABLED=1` 强制禁用本机执行；已有 `WORKFLOW_SANDBOX_MODE=workspace-write` 也会禁止本机执行。运行时模式不影响默认 Agent 工具选择，必须显式选择 `host_shell`。

记录使用 `workflow16080_shell_executions`、`workflow16080_shell_policy`、`workflow16080_shell_policy_events`。日志保留状态、模式、目录、命令、输出、退出码、耗时、来源与 Agent 运行标识，不自动删除。日志对已知凭据及常见敏感格式脱敏，但不是完整的数据防泄露系统。待审批/执行中的原始命令暂存于内部 `payload` 字段，以支持精确授权和重启恢复；终态、过期或失效后移除，不通过日志接口回传。不要在命令中嵌入密码或密钥。

```sh
pnpm test:host-shell
```

验收会短暂切换模式，只执行临时目录中的无害命令，验证审批、去重、拒绝、超时、取消、脱敏及两个 Agent 引擎的暂停恢复；使用合成模型响应，不调用付费模型。仅允许从隔离模式且没有活动任务时启动，结束恢复隔离模式，清理本次测试记录。
