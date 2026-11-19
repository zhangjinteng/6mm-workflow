# 16080 工作流能力接口

本机服务地址为 `http://127.0.0.1:16080`。在 `/nodes` 查看原有 21 个节点和新增 38 个节点。新节点均为固定 POST 路由，前缀为 `/api/workflow/nodes/`。请求使用 `application/json`，复用既有节点的 `{params, variables?, context?}` 结构。成功结果在 `data.result`，执行标识在 `data.requestId`。

## 接口清单

| POST 路由后缀 | params | result |
|---|---|---|
| `parseTxt` | fileId，encoding 可选 | 文本 |
| `parseMarkdown` | fileId，encoding 可选 | Markdown 及内嵌图片引用 |
| `parseCsv` | fileId，encoding 可选 | Markdown 表格 |
| `parseHtml` | fileId，encoding 可选 | Markdown 及图片 |
| `parsePdf` | fileId | 本地提取 PDF 文本层 |
| `parseDocx` | fileId | 文本、Markdown 及图片 |
| `parsePptx` | fileId | 幻灯片及备注文本 |
| `parseXlsx` | fileId | 工作表转 Markdown 表格 |
| `parsePdfCustom` | fileId，integrationId 可选 | 自定义服务解析的 Markdown、页数及图片 |
| `parsePdfTextIn` | 同上 | TextIn 解析结果 |
| `parsePdfDoc2x` | 同上 | Doc2X 解析结果 |
| `parseFile` | fileId，encoding、customPdfParse 可选 | 根据扩展名选择解析器 |
| `htmlToMarkdown` | html | Markdown 及内嵌图片 |
| `textToChunks` | text，切块参数可选 | chunks、chars |
| `previewFileChunks` | fileId，可选切块参数、limit、encoding、customPdfParse | chunks、total、chars |
| `readFiles` | fileIds，customPdfParse 可选 | files 数组，顺序与输入相同 |
| `moderateText` | text，policyId 可选 | decision 为 allow 或 reject，附 reason、provider |
| `listAuditLogs` | action、limit 可选 | 最近的调用记录，含 requestId、action、outcome、at |
| `modelChat` | messages，可选 modelId、maxTokens、temperature、censor、policyId | OpenAI 兼容 choices 或 Anthropic content |
| `modelEmbed` | input 为字符串或字符串数组，modelId 可选 | data[].embedding |
| `modelRerank` | query、documents，可选 modelId、topN | results 数组，含 index、relevance_score |
| `modelTts` | input，可选 modelId、voice | file.id 指向 MP3 文件 |
| `modelStt` | fileId，可选 modelId、language | text |
| `compressHistory` | messages，可选 modelId、maxTokens、budgetTokens | 可直接复用的 messages，可空的 checkpoint 和统计 |
| `compressFile` | fileId，可选 encoding、customPdfParse、modelId、budgetTokens | fileId、filename、text 和统计 |
| `compressToolResult` | toolName、result（文本或 JSON），可选 currentInputTokens、toolCount、modelId、budgetTokens | toolName、text 和统计 |
| `compressDatasetResults` | query、chunks（每块含 id、text，可选 source、score），可选 modelId、budgetTokens | selectedIds、对应原文 chunks 和统计 |
| `sandboxReadFile` | sessionId、path，可选 startLine、endLine（从 1 开始，含结束行） | path、startLine、endLine、totalLines、content |
| `sandboxWriteFile` | sessionId、path、content | path、bytes |
| `sandboxEditFile` | sessionId、entries，每项含 path、oldContent、newContent | paths；按顺序替换所有匹配原文，整批提交 |
| `sandboxSearch` | sessionId、pattern，可选 path | paths；递归按文件或目录名匹配，支持 * 和 ? |
| `sandboxGetFileUrl` | sessionId、paths | files，每项含 filename、fileUrl、expiresAt |
| `sandboxShell` | sessionId、command，可选 timeout（秒） | stdout、stderr、exitCode |
| `runJavaScript` | code，可选 variables、timeout | codeReturn、log；支持 async function main(variables) |
| `runPython` | code，可选 variables、timeout | codeReturn、log；入口为 def main(variables) |

解析类结果统一含 `text`、`parser`、`images`，增强 PDF 另含 `pages`。切块支持 `chunkSize`、`maxSize`、`overlapRatio`、`paragraphChunkDeep`、`paragraphChunkMinSize`。切块尽量保留段落与表格，`chunkSize` 为目标大小。批量读取每次 1–20 个文件。输入的精确类型、默认值、范围可通过能力目录读取。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/capabilities`、`/api/capabilities/{name}` | 全部新节点或单个节点的参数 JSON Schema |
| POST | `/api/files` | multipart 的 file 字段，或二进制请求体加查询参数 name。成功返回 201 和 data.id |
| GET、DELETE | `/api/files/{id}` | 读取文件元数据，或删除该文件 |
| GET | `/api/files/{id}/download` | 下载原始字节，包括解析生成的图片和合成的音频 |
| GET、POST | `/api/integrations` | 列出、创建增强 PDF 或审核连接 |
| GET、PATCH、DELETE | `/api/integrations/{id}` | 读取、更新、删除连接 |
| GET、POST、PUT、PATCH | `/api/models` | 沿用现有模型配置管理，执行节点接受返回的模型记录 id |
| POST | `/api/models/test` | 沿用模型连通性测试 |

## 调用示例

```sh
curl -sS -F 'file=@example.pdf' http://127.0.0.1:16080/api/files
curl -sS -H 'Content-Type: application/json' \
  -d '{"params":{"fileId":"替换为上一步的 data.id"}}' \
  http://127.0.0.1:16080/api/workflow/nodes/parsePdf
```

```sh
curl -sS -H 'Content-Type: application/json' \
  -d '{"params":{"text":"第一段。第二段。","chunkSize":128}}' \
  http://127.0.0.1:16080/api/workflow/nodes/textToChunks
```

## 服务配置与运行

| kind | 创建连接的字段 | 调用方式 |
|---|---|---|
| customPdf | name、url，可选 key | 通过 multipart 提交 file，可附 Bearer 凭据，上游返回 markdown、pages |
| textin | name、appId、key（Secret Code） | 向 TextIn 提交 PDF 原始字节 |
| doc2x | name、key | 预上传、向签名地址上传、轮询结果 |
| moderation | name、blockedTerms；使用 HTTP 服务时设 url、可选 key | 本地词条按子串匹配且忽略大小写；HTTP 提交 `{"text":"…"}`，响应 code 为 0/200 时放行、5000 时拒绝 |

连接通过 enabled 控制启停，默认为 true。自定义 URL 与模型地址沿用本项目的公网 HTTPS 443 访问约束。连接密钥存储于本实例 MongoDB，配置 API 仅返回 hasCredential。对 `parseFile`、预览和批量读取，`customPdfParse:true` 按“自定义 → TextIn → Doc2X → 本地”选择已启用配置。选中上游后，故障直接返回错误。单独增强节点可指定 integrationId。

五类模型均复用 16080 自有模型配置和凭据。请求可明确传 modelId，省略时取该类型已启用的默认模型。`modelChat` 设置 `censor:true` 或指定 `policyId` 时，先审核请求消息。命中拒绝时返回 422，审核不可用时返回错误，模型调用在审核通过后执行。模型与审核调用留痕于 `workflow16080_audit`，日志记录操作及结果，不保存请求正文、文件内容或凭据。

文件默认存放在 `.workflow-data/files`，可设置 `WORKFLOW_FILE_DIR` 指向持久目录。所有解析和模型节点通过文件 ID 引用本机文件。上传请求体上限 24 MiB，JSON 请求体上限 1 MiB。文件由调用方通过 DELETE 管理，包括解析生成的图片和音频。服务配置和审计使用现有 MongoDB 连接。

本地解析使用独立 Node Worker。共享并发上限默认 4，可用 `PARSE_FILE_WORKERS` 设置为 1–32；超时默认 120 秒，`PARSE_FILE_TIMEOUT_SECONDS` 支持 60–6000。HTML 转换阈值 `MAX_HTML_TRANSFORM_CHARS` 默认为 1000000。重启进程后使用新的环境配置。常见错误包括 400 参数无效、404 记录不存在、409 模型不可用或配置冲突、413 请求过大、422 格式不匹配或内容被拦截、429 解析繁忙、502/504 上游失败或超时、503 缺少服务配置。

部署需包含生产依赖、构建产物及仓库内的 `workers/`。解析器源码和哈希在本项目内，运行时直接读取本地文件并直连所选模型或 PDF／审核供应商。仅在重新提取快照时需要来源仓库。

```sh
node scripts/migrate-workflow-nodes.mjs --documents --source=/absolute/path/to/workflow-zjt
node scripts/capability-routes.mjs --source=/absolute/path/to/workflow-zjt
```

`pnpm test` 运行单元和上游协议测试。`pnpm test:api` 回归原有 21 个节点。`pnpm test:capabilities` 对运行中的服务上传临时样本，校验八种格式、文本、审核、模型错误与配置管理，并清理测试文件及连接；审核和模型调用的审计记录会保留。使用 `NODE_API_BASE_URL` 可测试独立的生产构建实例。


## Agent 会话与独立代码执行

| 方法 | 路径 | 请求与结果 |
|---|---|---|
| POST | `/api/sandbox/sessions` | 发 `{}` 或传 `fileIds`、`mode`。201 返回 `data.sessionId`、实际权限、到期时间及附件相对路径 |
| GET | `/api/sandbox/sessions/{id}` | 查询有效会话及到期时间 |
| DELETE | `/api/sandbox/sessions/{id}` | 关闭会话，取消活动 Shell；重复调用返回 204 |
| GET | `/api/sandbox/artifacts/{token}` | 本机下载导出时的文件快照。链接自导出起有效两小时，早于到期关闭会话仍可下载 |

工作目录和文件字节保存在 MongoDB 的 `workflow16080_sandbox_sessions`，有效期两小时。目录限 512 项，文件总计 8 MiB。输入文件可先通过 `/api/files` 上传，再按 `fileIds` 导入。文件节点使用相对路径，Shell 的起始目录为 `/workspace`。Shell 支持管道、重定向和内置 Unix 命令，使用虚拟文件系统。只有工作目录的文件和目录会写回会话；包含符号链接的变更会被拒绝。导出文件独立保存于 `workflow16080_sandbox_artifacts`，两类集合都有 TTL 索引，接口会即时校验有效期。

服务端 `WORKFLOW_SANDBOX_MODE` 默认值为 `isolated-shell`，创建会话时可降为 `workspace-write`。若服务端设为 `workspace-write`，现有会话也会禁止 Shell，工具返回 `exitCode: -1`。并发修改同一会话时只有与当前版本一致的修改会提交，冲突返回 409。执行结果和耗时可用 `listAuditLogs` 按节点名查询。

两个代码节点每次创建独立的执行环境。默认使用随依赖安装的 QuickJS 和 CPython WebAssembly 执行器，在单独的 Node 子进程运行。只传递 `params.variables`，顶层 `variables` 仍是工作流状态。默认执行环境可以使用运行时内置模块，可用模块与原服务的第三方模块白名单有差异。Shell、JS、Python 默认限时 15 秒，可指定 1–60 秒，每个 16080 服务进程同时运行最多 4 个执行任务。

例如，以下输入计算两数之和。

```json
{"params":{"code":"def main(v):\n return {'sum': v['a'] + v['b']}","variables":{"a":19,"b":23}}}
```

将上面的 JSON 发给 `POST /api/workflow/nodes/runPython`，结果在 `data.result.codeReturn.sum`。一般代码异常返回 422，超时返回 504，并发已满返回 429。

### 使用原 Code Sandbox 协议

部署中如需原执行器，可使用项目根目录的 `compose.sandbox.yaml`。为 Compose 和 16080 设置相同的 `WORKFLOW_CODE_SANDBOX_TOKEN`，执行 `docker compose -f compose.sandbox.yaml up -d`，再将 16080 的 `WORKFLOW_CODE_SANDBOX_URL` 设为 `http://127.0.0.1:16082` 并重启。留空时直接使用内置执行器。原服务的执行时限由 `SANDBOX_MAX_TIMEOUT` 控制，节点的 `timeout` 另外限制 HTTP 等待时间。代码服务离线时，两个代码节点返回 503，会话文件节点和 Shell 仍可用。

在配置好本实例 MongoDB 且 16080 运行时，`pnpm test:sandbox` 验证 8 个接口、会话隔离、下载过期、异常和超时。测试只操作各用例创建的会话、上传与快照。

## 上下文压缩

四个压缩节点均支持可选的 `maxTokens`（给正式回答预留）、`budgetTokens`（进一步收紧输入或结果预算）、`censor` 或 `policyId`。指定已启用的语言模型记录 ID，或使用默认语言模型。每次调用返回 `tokensBefore`、`tokensAfter`、`budgetTokens`、`strategy`、`modelCalls` 和 `warnings`。前三项均使用本地 o200k 分词估算；供应商返回的实际用量列在 `data.usages`。

历史达到模型窗口的 80%，或超过本次实际输入预算时，保留系统指令、最新用户问题及其后的消息，压缩较早历史。文件和工具结果默认上限为窗口的一半，同时受可用空间限制。超过预算先去除长链接、内嵌数据和冗余空白，仍超限则分块摘要。知识库结果超过窗口的 20% 或本次分配预算时，模型按 query 选择 ID；异常或无有效 ID 时按分数和输入顺序装入完整原文。无法容纳任何完整分块会返回空列表和警告。

`POST /api/workflow/nodes/modelChat` 默认关闭压缩。以下示例使用默认语言模型：

```json
{
  "params": {
    "messages": [{"role":"user","content":"根据验收记录，谁负责核对订单？"}],
    "compression": {
      "enabled": true,
      "sources": [
        {"type":"tool","toolName":"orderStatus","result":{"status":"待验收"}},
        {"type":"dataset","query":"订单核对负责人","chunks":[{"id":"r1","text":"小林负责核对订单。","source":"验收记录"}]}
      ]
    }
  }
}
```

文件来源形如 `{"type":"file","fileId":"已上传文件的 UUID"}`，可选 encoding、customPdfParse。只传 `{"enabled":true}` 时仅检查历史。系统先为回答预留 `min(maxTokens 或 maxResponse, maxResponse)`，另外保留窗口的 2%（至少 8 Token）作为估算余量，再分配来源与历史预算。所有来源和消息先通过本次启用的审核策略，然后才可调用摘要、筛选或聊天模型。默认和显式关闭时均走原聊天路径。

正式模型响应仍在 `data.result`，启用压缩时另返回 `data.compression`，含各来源统计、历史统计、可复用的 checkpoint 以及警告。其 `modelCalls` 只计摘要与筛选调用。checkpoint 以 user 消息携带进入下轮，请同时提供之后新增的对话。系统指令和当前问题超限、或历史/文件/工具结果超过预算且摘要失败时返回 422。接口不依赖 3011。运行 `pnpm test:compression` 将使用当前启用的真实语言模型和合成测试数据，可用 `COMPRESSION_MODEL_ID` 指定记录。

## Agent 执行与工具装配

| 方法与路径 | 输入 | 返回 |
|---|---|---|
| POST `/api/workflow/nodes/previewAgentTools` | 模型、工具、会话、附件、Skills、沙箱及模态配置 | 有效引擎、工具 Schema、被排除的工具及原因、固定的 Skill 版本、附件处理方式。预览只读取配置和元数据 |
| POST `/api/workflow/nodes/runAgent` | 相同配置加 `message`。可传 `background: true`、`maxSteps`、`runId`、`datasetChunks` | 运行 ID、会话 ID、状态、答案、工具调用与实际模型用量 |
| POST `/api/workflow/nodes/resumeAgent` | `runId`、`interactionId`、`answer` | 继续同一次运行。重复回答返回已保存状态，冲突回答返回 409 |
| GET `/api/agent/runs/{runId}` | 路径中的运行 ID | `data.status`、`pending`、`plan`、`trace`、`answer` 或 `error` |
| POST `/api/agent/runs/{runId}/cancel` | 路径中的运行 ID | 取消后续工作，返回终态；已完成的工具操作保留 |

先用 `POST /api/files?name=inventory.txt` 上传文件，再将返回的 `data.id` 传入运行节点。以下示例的两个 ID 均需替换。

```json
{
  "params": {
    "engine": "default",
    "modelId": "<语言模型记录 UUID>",
    "message": "读取盘点记录，返回正文中的核验码。",
    "attachments": [{"fileId":"<上传文件 UUID>"}],
    "maxSteps": 8
  }
}
```

节点结果位于 `data.result`。同步请求等到完成、失败或等待用户输入；后台请求可立即查询。状态为 `queued`、`running`、`waiting_input`、`waiting_approval`、`completed`、`failed` 或 `cancelled`。调用方应检查状态和 `error`。追问时取 `pending.interactionId`，提交给恢复节点；本机命令审批使用 `pendingApproval.executionId`，不接受普通追问回答作为授权。相同 `runId` 与相同请求可安全重试。每个会话同一时刻只能有一次活动运行。MongoDB 集合 `workflow16080_agent_runs` 保存运行快照，查询会重新调度排队或租约超时的任务。中断时结果不明确的工具调用将结束为失败，便于核对。

- `selectedTools` 接受本地工具名。可选文本工具有 `htmlToMarkdown`、`textToChunks`。`canSelectFile` 控制 `read_files`，文件 ID 受当前及历史可见文档限制。`ask_agent`、`update_plan` 随运行装配。
- `sessionId` 跨任务复用历史及附件。`skills: [{skillId,version}]` 可省略版本，默认固定当前发布版本。`editSkillId` 选择草稿快照。工作区的编辑只保存在沙箱中。Skill 会启用文件沙箱，模型按需读取包内说明和资源。
- `sandbox` 取 `off`、`workspace-write` 或 `isolated-shell`。文件工具包括读取、写入、编辑、搜索和生成下载链接，最后一种模式还可装配隔离 Shell；服务端权限设定仍生效。
- `selectedTools: ["host_shell"]` 显式装配真实本机执行工具，参数为 `command`、可选绝对路径 `cwd`、`timeout`（1至120秒，默认30秒）。是否可用及审批规则由 `/shell` 的服务端模式决定，不接受工具参数提权；原虚拟沙箱工具保持不变。
- `modalities.vision` 需要模型标记支持视觉，图片通过协议中的原生图片块发送。`modalities.audio: "transcribe"` 可配 `sttModelId` 或使用默认转写模型。预览会列出原生音视频、未知格式和缺少模型配置的原因。
- `datasetChunks` 传入外部已检索的 `{id,text,source?,score?}`。运行按预算选取资料；文件、工具及历史超预算会压缩。每个工具调用按 ID 对应结果；当前尚未完成的调用组保留。`censor` 与 `policyId` 可启用已有文本审核策略。

## Shell 控制台接口

所有接口仅本地同源访问，返回 `data`，错误为 `error`。本机执行没有 OS 隔离，详见 README 的权限和日志限制。

| 接口 | 输入 | 返回 |
| --- | --- | --- |
| `GET /api/shell/policy` | 无 | mode、cwd、revision、updatedAt、disabled |
| `PUT /api/shell/policy` | mode、cwd（本机绝对路径）、revision；本机模式要求 acknowledged: true | 更新后的服务端模式；旧审批失效 |
| `GET /api/shell/executions` | 无 | 最新50条执行记录，包含待审批及执行中任务 |
| `POST /api/shell/executions` | requestId（UUID）、policyRevision、command、timeout；可选 cwd | 执行记录或 pending 审批记录，相同 requestId 与命令重放不重复执行；权限版本不符时拒绝执行 |
| `GET /api/shell/executions/{id}` | 执行标识 | 单条执行记录 |
| `POST /api/shell/executions/{id}` | decision: approve / deny / cancel，confirmed: true | 批准、拒绝或取消后的记录 |

模式为 `isolated-shell`、`host-shell`、`danger-full-access`。记录包含 id、command（脱敏）、cwd、mode、timeout、status、reason、source、runId/toolCallId（Agent来源）、stdout/stderr、exitCode、durationMs、truncated、createdAt/finishedAt/expiresAt。status 为 pending / running / completed / failed / denied / cancelled / expired / interrupted；记录中不返回内部原始命令 payload。

```json
{
  "params": {
    "message": "请检查本机当前工作目录",
    "selectedTools": ["host_shell"],
    "maxSteps": 4
  }
}
```

以上请求发送至 `POST /api/workflow/nodes/runAgent`，前提是在本地控制台显式启用本机模式。审批后可查询 `GET /api/agent/runs/{runId}` 继续调度。完全访问模式不产生逐条审批，但仍保留日志、超时、取消、输入校验和本地访问限制。
- 默认引擎通过 `AGENT_ENGINE` 设置，允许的引擎通过 `WORKFLOW_AGENT_ENGINES` 设置，默认允许 `default,pi`。`default` 使用 OpenAI 兼容或 Anthropic 协议，`pi` 通过锁定的 SDK 和本服务的模型连接运行。Pi 默认开放实测的 DeepSeek deepseek-flash，其他已验证的兼容模型可按上游 ID 添加到 `WORKFLOW_AGENT_PI_MODELS`（逗号分隔）。
- 真实模型验收运行 `pnpm test:agent`；完整 Skill、沙箱写文件及追问用例运行 `node scripts/smoke-agent-session.mjs`。两者支持 `AGENT_TEST_MODEL_ID`，使用当前服务的模型额度。默认目标为本机 16080。
