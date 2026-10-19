# DSP 点表批量添加

当前支持 DSP 内部数据（`process`）及 UPP 转发（`forward`）。采集表及其他板卡暂未启用。

## 操作步骤

1. 选择项目、DSP 和目标表，取得项目编辑权。
2. 查询合法分组/端点代码及内部点 ID，填写 Excel；新增转发前先保存被引用的内部点。
3. 上传或调用批量预览接口，查看逐行错误及关联影响。预览不保存业务行。
4. 校验通过后一次确认提交；任何行失败整批回滚。冲突时保留原文件/草稿并重新检查，不直接覆盖。

一次最多 200 行，只追加新记录。网页单元格粘贴用于修改现有行，批量添加用于新建。

## Node.js 示例

```bash
npm ci --prefix scripts/excel-batch
node scripts/excel-batch/index.mjs --kind process --template points.xlsx
```

设置 `PROTOCOL_USERNAME`、`PROTOCOL_PASSWORD`，或已有 `PROTOCOL_SESSION`；不要把口令放进命令行或提交到 Git。

```bash
node scripts/excel-batch/index.mjs --project 1 --board DSP --kind process --references refs.json
node scripts/excel-batch/index.mjs --project 1 --board DSP --kind process --file points.xlsx --report preview.json
node scripts/excel-batch/index.mjs --project 1 --board DSP --kind process --file points.xlsx --commit --report saved.json
```

使用 `--kind forward` 生成并上传转发表。`--sheet` 指定工作表，`--url` 指定服务地址。默认只预览；`--commit` 才会提交。模板、引用和报告文件不覆盖已有文件。

| 表 | 必填字段 |
| --- | --- |
| process | `name`、`variable_name`、`sheet_type`（如 `Sys_U16`） |
| forward | `process_point_id`、`endpoint_key`、`name`、`upp_model`、`address`、`wire_type`、`wire_length` |

`group_key` 默认 `LOCAL`；`endpoint_key` 通常为 `UPP_SERVICE`，均以实际 JSON 配置为准。引用接口返回 `native_groups`、`process_points`、`endpoints`。DSP 内部没有 sigID，模板按原 sheet 的可写字段填写，派生列不上传。兼容旧脚本的 `enum_name` / `internal_type` 输入。内部类型、长度、范围、元数据选项和转发转换在服务端统一校验；比例 `scale` 可填小数。

第一行保留英文字段名，第二行开始填数据。空单元格省略并采用字段默认值，公式须先粘贴为值；拒绝合并单元格、重复/未知表头、超精度数字和跨项目引用。模板注释列出字段含义。

脚本自动申请并续期编辑权，预览结束或提交成功后释放。提交响应丢失时结果未知，必须先查看网页或审计记录，避免重复新增。

## API

读取：`GET /api/projects/{pid}/boards/DSP/point-tables/process`

预览：`POST /api/projects/{pid}/boards/DSP/point-tables/process/batch/preview`

```json
{
  "revision": 3,
  "rows": [
    {"row": 2, "values": {"name": "电压", "variable_name": "TestVoltage", "sheet_type": "Sys_U16"}}
  ]
}
```

成功返回 `allowed: true` 和预览 `id`；失败返回 `errors`，含来源行、字段和原因。确认调用 `POST /api/projects/{pid}/changes/{id}/commit`，正文 `{}`。写请求必须携带会话及 `X-Requested-With: protocol-studio`。

编辑权接口为 `/api/projects/{pid}/edit-lock/acquire`、`renew`、`release`（POST）。提交校验当前权限、租约、revision 和关联；原子写入点、历史、审计。无关字段变化可合并，同字段/引用冲突返回 409。

## 验证

```bash
node --test scripts/excel-batch/workbook.test.mjs
node tests/integration.mjs
```
