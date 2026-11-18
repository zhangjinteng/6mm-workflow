# 工作流节点函数独立接口迁移

## 范围

- 目标：`/Users/zhangzhang/Github/zjt-workflow`，本地 Next.js 服务端口 16080。
- 来源：`/Users/zhangzhang/Github/workflow-zjt/fastify/vendor`。
- 用户已明确：只搬处理函数并分别开放接口，不要求工作流功能完整。
- 迁入处理函数及必需的纯函数依赖，不连接原 3011，不搬数据库、鉴权、计费、SSE、子工作流调度器。
- 来源文件不修改、不删除；迁入快照保留来源、导出名与 SHA-256，通过脚本机械生成。

## 接口清单

以下均为 `POST /api/workflow/nodes/<节点名>`，每项有单独 `route.ts`：

| 节点名 | 原函数 | 原 dispatch 相对路径 |
| --- | --- | --- |
| workflowStart | dispatchWorkflowStart | init/workflowStart.tsx |
| datasetConcatNode | dispatchDatasetConcat | dataset/concat.ts |
| answerNode | dispatchAnswer | tools/answer.ts |
| variableUpdate | dispatchUpdateVariable | tools/runUpdateVar.ts |
| textEditor | dispatchTextEditor | tools/textEditor.ts |
| customFeedback | dispatchCustomFeedback | tools/customFeedback.ts |
| ifElseNode | dispatchIfElse | tools/runIfElse.ts |
| userSelect | dispatchUserSelect | interactive/userSelect.ts |
| formInput | dispatchFormInput | interactive/formInput.ts |
| parallelRun | dispatchParallelRun | parallelRun/runParallelRun.ts |
| loopRun | dispatchLoopRun | loopRun/runLoopRun.ts |
| loopRunStart | dispatchLoopRunStart | loopRun/runLoopRunStart.ts |
| loopRunBreak | dispatchLoopRunBreak | loopRun/runLoopRunBreak.ts |
| loopStart | dispatchLoopStart | loop/runLoopStart.ts |
| loopEnd | dispatchLoopEnd | loop/runLoopEnd.ts |
| stopTool | dispatchStopToolCall | ai/toolcall/stopTool.ts |
| toolParams | dispatchToolParams | ai/toolcall/toolParams.ts |
| pluginInput | dispatchPluginInput | plugin/runInput.ts |
| pluginOutput | dispatchPluginOutput | plugin/runOutput.ts |
| loop | dispatchLoop | abandoned/runLoop.ts |
| userGuide | dispatchSystemConfig | init/systemConfig.tsx |

## HTTP 契约

- 请求 JSON：`{ params: {}, variables?: {}, context?: {} }`；params 使用原函数的真实键名。
- context 支持 node、runtimeNodes、runtimeEdges、query、histories、lastInteractive、runningAppInfo、stopping。
- 服务端为单次调用构建变量读写对象、nodes Map；事件和 usage 回调只收集到响应，不对外持久化。
- 成功：`{ code: 200, data: { nodeType, result, variables, runtimeNodes, events, usages, warnings } }`。
- 400：非法 JSON / 请求结构或已知节点参数错误；422：函数执行错误；501：触及未迁移能力。
- 使用本地 parseApiInput 做请求边界校验，错误响应不包含服务端堆栈。

## 风险与明确不做

- parallelRun / loopRun / loop：空输入仍可得到原函数结果；真实子工作流执行明确报 runtimeUnavailable。即使原函数捕获异常，也从调用诊断中标记 501，避免误报完整执行成功。
- 表单解密、文件 key 签名：仅依赖该能力的分支报 runtimeUnavailable；普通文本及已有 URL 不受影响。
- 变量是单请求内存状态，不保证原系统的密文存储、schema 校验、持久化及并发行为。
- loop 为废弃兼容函数；userGuide 为 systemConfig 的字符串值，不新增另一套业务含义。
- 这些是本地函数调试接口，不提供 FastGPT 用户鉴权；限制为本机访问并拒绝跨站 Origin。不可直接作为公网业务 API。
- 源函数可能仍返回错误结果字段，HTTP 200 只代表函数调用完成，不代表完整工作流成功。
- 必需纯函数按源码声明依赖闭包提取并转译为 JS，源表达式不重写；生成目录不手工修改。

## TODO

- [x] 确认 16080 项目、源函数、范围与路由清单。
- [x] 生成 21 个函数与最小纯函数依赖快照，保留许可和来源。
- [x] 实现输入校验、单调用上下文适配和 21 个独立 API。
- [x] 覆盖每个节点、失败分支及请求间隔离的局部测试。
- [x] 运行 typecheck、lint、全量测试（46/46）和生产构建。
- [x] 在 16080 实际请求验证全部 21 个接口和 4 个失败分支，并补齐调用文档。

## 调用参数参考

请求中的 `params` 直接传给原函数，不自动解引用整张工作流的节点输入。
`context.node` 可设置 `nodeId`、`isEntry`、`inputs`、`outputs`；
`context.runtimeNodes` 每项需要 `nodeId` 和 `flowNodeType`，用于变量引用和子节点检查。

| 节点 | params 最小示例 |
| --- | --- |
| workflowStart | `{"userChatInput":"你好"}` |
| datasetConcatNode | `{"limit":5000,"source1":[{"id":"1","q":"问","a":"答","score":[]}]}` |
| answerNode | `{"text":"回答"}` |
| variableUpdate | `{"updateList":[]}` |
| textEditor | `{"system_textareaInput":"Hello {{name}}","system_addInputParam":{"name":"ZJT"}}` |
| customFeedback | `{"system_textareaInput":"反馈"}` |
| ifElseNode | `{"ifElseList":[]}` |
| userSelect | `{"description":"请选择","userSelectOptions":[{"key":"a","value":"A"}]}` |
| formInput | `{"description":"请输入","userInputForms":[{"key":"name","type":"input"}]}` |
| parallelRun | `{"loopInputArray":[],"childrenNodeIdList":[]}` |
| loopRun | `{"loopRunMode":"array","loopRunInputArray":[],"childrenNodeIdList":[]}` |
| loopRunStart | `{"loopRunMode":"array","loopStartInput":"item","loopStartIndex":1}` |
| loopRunBreak | `{}` |
| loopStart | `{"loopStartInput":"item","loopStartIndex":1}` |
| loopEnd | `{"loopEndInput":"result"}` |
| stopTool | `{}` |
| toolParams | `{"question":"你好"}` |
| pluginInput | `{"question":"你好"}` |
| pluginOutput | `{"answer":"结果"}` |
| loop | `{"loopInputArray":[],"childrenNodeIdList":[]}` |
| userGuide | `{}`，变量通过顶层 `variables` 传入 |

变量更新示例：

```json
{
  "params": {
    "updateList": [{
      "variable": ["VARIABLE_NODE_ID", "count"],
      "renderType": "input",
      "valueType": "number",
      "value": ["", "3"],
      "numberOperator": "+"
    }]
  },
  "variables": { "count": 2 }
}
```

交互恢复需要手工提供 `context.node.isEntry=true`、`lastInteractive.type` 和 `query`，
`userSelect` 类型为 `userSelect`，`formInput` 类型为 `userInput`。
例：`"query":[{"text":{"content":"A"}}]`；表单的 content 为 JSON 字符串。
函数返回的 `INTERACTIVE` 只代表交互描述；接口不维护会话。

输出保留原来的字符串键：如 `responseData`、`system_text`、`system_error_text`。
变量改变读取 `data.variables`，节点输出改变读取 `data.runtimeNodes`，收集到的流事件读取 `data.events`。

可选环境变量见项目 `.env.example`：`WORKFLOW_MAX_LOOP_TIMES` 默认 100，
`WORKFLOW_PARALLEL_MAX_CONCURRENCY` 默认 10；均限制为 1–1000 的正整数。
