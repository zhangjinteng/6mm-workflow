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

16080 新增 23 个独立节点，连同原有节点共 44 个。完整路由、参数、配置、调用示例和测试方法见[接口清单](docs/capabilities.md)。运行中的服务通过 `GET /api/capabilities` 提供新增节点的参数 Schema。
