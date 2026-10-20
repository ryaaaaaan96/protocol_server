# UPM 点表

UPM 内部按 `LOCAL` 和 `DSP` 两个设备模板组织。LOCAL 是本地设备，没有采集表；DSP 共用一份点定义，设备实例与地址保存在 `config/dc-ups/project.json` 的 `point_groups[].devices` 中。

## 来源与关联

| 入口 | Excel 来源 | 存储与关联 |
| --- | --- | --- |
| UPM 内部点 / LOCAL | `UPM单板测点` | 161 个内部点；相同枚举的多地址行合并，保留源行位置 |
| UPM 内部点 / DSP | `UPM-DSP采集数据` | 445 个接收端内部点，与 DSP 板卡自己的内部点独立 |
| DSP UPP 采集表 | `UPM-DSP采集数据` | 445 条采集映射引用 UPM 的 DSP 模板内部点 |
| Modbus 对外表 | 上述两张表的 Modbus 地址列 | 531 条模板映射；一个内部点可以有多个地址 |
| CSU-UPM UPP 对外表 | `CSU-UPM采集数据` | 只导入来源为 UPM 的 29 行；7 行 CSU 本地处理不导入 |

内部点保存在 `points.process_points`，采集保存在 `points.collect_points`，两种对外映射共用 `points.transmit_points`，以端点区分。引用使用稳定记录 ID；sigID 属于各自接收设备，不能用 CSU 的 sigID 覆盖 UPM，也不能用 UPM 的 sigID 覆盖 DSP。

## 设备与地址

DSP1～DSP8 的设备地址分别配置为 1～8，Modbus 基址按 `UPM板内Modbus地址分配` 设置为 50000～57000，间隔 1000：

```json
{"code":"DSP1","name":"DSP 设备 1","dev_id":1,"modbus_base":50000}
```

Modbus 实际地址为 `modbus_base + address`，地址单位为寄存器，数量为 `ceil(wire_length / 2)`。LOCAL 的基址为 0。UPP 的 `address` 是模型内字节偏移；不同设备实例共用模型布局。界面“设备地址”列展示各实例地址，修改模板影响所有实例。

Modbus 优先采用备注中的 `0x03`（HOLDING）或 `0x04`（INPUT）；缺少备注时，本地 RO 使用 INPUT，其余使用 HOLDING。DSP 对外偏移采用 HOLDING。字节序初始为 0，可在 UPM 协议表中修改，部署前需核对固件。

## 导入与升级

已有项目首次增加 UPM，先停止旧 HTTP 服务，再执行：

```bash
cargo run -- migrate
cargo run -- import-upm dc-ups
./scripts/dev.sh
```

`import-upm` 验证并应用项目 JSON，仅在 UPM 无内部点时导入，重复运行保留已有点表，DSP 点数据不会被改写。与他人的编辑租约冲突时拒绝执行。新项目通过 `./scripts/create-project.sh dc-ups` 同时导入 DSP 与 UPM。

网页 Excel 导入可选择 DSP 或 UPM；确认替换只影响所选板卡。文件夹导入不带 Dump 仍然不替换点表。新版 Dump 为 `(schema_version, migration_version) = (6, 3)`，包含三张业务表，兼容旧 `(4, 1)`、`(5, 2)` 两表归档；旧归档导入后的采集表为空。

## 校验与来源差异

所有编辑使用现有预览、权限、版本合并、编辑租约和历史记录。采集记录也进入 `history.events`，类型为 `collect`。地址冲突按设备、协议和寄存器区检查；LOCAL 不允许添加采集映射。

- 根据用户确认，源 Excel `UPM单板测点!I138` 已由 U32 改为 U16，保留 2 字节、1 个寄存器。
- `※`、空值及占位 sigID `0` 不编造编号，保留原值来源并提示核实。
- 403 行上传数据的轮询参数保持为空；42 行按轮询方式导入。
- 既有范围倒置或符号值保留为来源警告；新增不合法修改会被拒绝。
- UPM 本轮保留 Excel 地址，不启用自动重排脚本，也不自动跟随 DSP 侧后续编辑。两端协议修改需分别核对。

生成产物包括 UPM 的三类点表 JSON 和按设备展开的转发地址 JSON，仍需固件侧验证。
