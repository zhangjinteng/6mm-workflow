# 16080 文件、文本、审核与模型接口

本机服务地址为 `http://127.0.0.1:16080`。在 `/nodes` 查看原有 21 个节点和新增 23 个节点。新节点均为固定 POST 路由，前缀为 `/api/workflow/nodes/`。请求使用 `application/json`，复用既有节点的 `{params, variables?, context?}` 结构。成功结果在 `data.result`，执行标识在 `data.requestId`。

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

