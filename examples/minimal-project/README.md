# 最小项目模板

此目录长期保留，作为新项目起点及独立验收样本，不依赖 DC-UPS 工作簿、板卡目录或脚本。没有 Dump／Excel 来源，首次创建的点表为空；不自动加入正在使用的项目。

## 使用

1. 复制整个目录到 `config/<新项目key>/`，修改 `project.json` 的 `key` 与目录名一致，并修改 `name`。
2. 按需要修改板卡代码、型号、分组、端点和显示列。`directory` 指向 `sensor/`；改名时同步更新引用和 `workspace.boards`。已创建项目的稳定键不要随意更改。
3. 使用网页“导入项目文件夹”，或在数据库已初始化、服务已安装的环境运行：

   ```bash
   ./target/debug/protocol-server create-project <新项目key>
   ```

4. 网页打开板卡内部信息，取得编辑权后添加处理点，再按内部点创建采集／转发。新增项目不需要修改或重新构建 Rust、Vue、TypeScript，不需要新增迁移。

## 文件与规则

| 文件 | 用途 |
| --- | --- |
| `project.json` | 单个 SENSOR_NODE 板卡、CHANNELS 分组、UPP 输入与 Modbus 输出 |
| `sensor/process.json` / `process.js` | 处理点、自定义 `gain` 元数据；校准系数为 1～10 的整数，显示“名称 × 系数” |
| `sensor/collect.json` | UPP 采集，模型、字节偏移和轮询参数独立编辑 |
| `sensor/transmit.json` / `transmit.js` | Modbus 转发；类型宽度和基准地址由 JSON 参数指定 |

转发按内部枚举、映射 ID 排序，从寄存器地址 1000 连续分配：`下一地址 = 当前地址 + ceil(协议字节数 / 2)`。U16 占 1 个寄存器，U32 占 2 个；`wire_length` 始终表示字节。此最小算法适用于一个输出端点，不代表任何硬件的实际地址规范。

可先创建 U16 的 PRESSURE 和 U32 的 TEMPERATURE，再创建对应转发，得到 1000／1001。校准字段仅演示元数据及显示投影，不改变实际采集值。修改已有布局规则后，通过“重算协议布局”预览确认；配置读取不会写点数据。

## 验收

```bash
cargo build --locked
npm run build --prefix frontend
node tests/integration.mjs --onboarding
# 安装 Playwright Chromium 及其系统依赖后，增加真实浏览器验收：
node tests/integration.mjs --onboarding --browser
```

测试只复制本目录到临时配置根，建立并清理临时平台库和项目库。浏览器访问实际 Rust 服务及前端构建产物，不模拟业务 API。更完整的多设备展开、子集同步、工作簿导入和权限示例见 [配置指南](../../docs/board-configuration.md)。
