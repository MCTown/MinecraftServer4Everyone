# 部署进度随实际操作合并

## 参考与边界

参考 OpenCode V2 `4617210822bdbb31e5749751afbfb4584ccedac8`：

- `packages/core/src/tool.ts` 的工具上下文提供 `progress` 回调。
- `packages/core/src/tool/plugin/shell.ts` 在实际 Shell 操作内部发布进度。
- `packages/core/test/session-tool-progress.test.ts` 区分即时 Tool.Progress 与持久化的 Tool.Success / Tool.Failed。

本项目借鉴的是“不为展示进度单独请求模型”和“进度不等于成功证据”，不是引入 OpenCode Todo。现有部署阶段仍持久化在执行记录内，没有照搬其 live-only 工具进度存储机制。

## 新部署协议

实际工具支持两个可选公共字段，进入业务工具前会剥离，不影响其原参数：

```json
{
  "workflowStepId": "prepare_server_slot",
  "workflowUpdates": [
    { "stepId": "identify_modpack", "status": "completed", "detail": "用户已明确确认整合包和版本" }
  ]
}
```

- `workflowStepId` 继续用于 Job / 资源归属；新部署在真正执行工具时自动标记 running，异常或 TOOL_ERROR 标记 failed。
- `workflowUpdates` 是对**此前结果**的语义判断，在本次业务操作前合并提交，不预测本次操作成功。所有元数据先校验，非法/禁用步骤不会执行业务副作用。
- 工具成功不自动将整个阶段标为 completed；后台回执也不表示阶段完成。等待后台真实结果后，模型可在下一次实际操作上合并完成状态。
- 后台任务使用同一执行路径，在真实结算时更新；取消、拒绝确认不伪装成工具失败，迟到任务不能修改另一执行的展示。
- 不要求逐工具汇报或编造细碎百分比。没有后续实际操作时，保留独立进度工具作收尾或纠正。
- 旧分轮记录继续采用原协议恢复；不改历史检查点，不引入新调度器或自动证据判定器。

## 验证

`workflowToolProgress.test.ts` 覆盖元数据校验；`workflowTurns.test.ts` 覆盖真实操作合并更新、无独立汇报调用、业务失败、后台真实结算和持久化。模型桩验证协议无需额外汇报回合，不等于真实模型性能基准；实际 Token / 耗时收益须另行隔离验收。
