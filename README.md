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
```

运行不依赖来源仓库。子工作流引擎、存储签名和密文解密未迁入，触及这些分支时返回 HTTP 501。
