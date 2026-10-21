# JSON 与 Excel 导出

- 页面右上角 **导出项目**：JSON 下载当前项目的已保存原生点表、拓扑和表规则快照；Excel 下载按板卡、分组、表格及协议端口拆分工作表的 `.xlsx`。项目 Excel 保留未分配 sigID 的内部点，并按配置展开转发设备实例；派生采集表也包含在内。
- 点表工具栏 **导出**：处理、采集、转发和总体视图均支持 JSON／Excel。导出当前筛选下的全部行，包含其他分页，列顺序和隐藏设置与当前视图一致。设备展开模式导出实际地址；共享模板模式导出模板值。
- 当前视图存在未保存修改时，先保存或放弃再导出。查看权限即可导出，不申请编辑锁，不修改数据和版本。成功与失败通过浮窗反馈。

项目导出采用同一事务快照和当次冻结的表定义；不执行重算写入。JSON 快照保留原生存储值，Excel 使用表规则的显示投影。Excel 是数据报表；项目文件夹迁移仍使用 `scripts/export-project.mjs` 生成的 `project.dump`。

接口：

| 接口 | 用途 |
| --- | --- |
| `GET /api/projects/:id/export` | 项目 JSON 快照，保留原有接口 |
| `GET /api/projects/:id/export.xlsx` | 项目 Excel 工作簿 |
| `POST /api/projects/:id/export-table` | 将已加载的表格视图转换为 Excel，要求项目查看权限 |

当前视图 JSON 包含 `title`、`context`、`columns: [{key, label}]`、`rows: [{列标识: 值}]`；Excel 转换接口接受相同结构。每张表最多 10 万行、128 列、50 万单元格，单元格文字最多 32767 个 UTF-16 字符。工作簿最多 512 张表、200 万单元格。

Excel 使用 [rust_xlsxwriter](https://github.com/jmcnamara/rust_xlsxwriter)，不依赖服务器安装 Excel。公式形态的源文本按文字写入，前导零及长整数按文本保留；表头冻结并支持筛选。验证：`cargo test table_export`、`node tests/integration.mjs --exports`、`cd frontend && node browser-check.mjs`。
