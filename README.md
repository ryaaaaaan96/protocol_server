# Protocol Studio · 协议管理平台

使用 **Rust + Vue 3 + TypeScript + PostgreSQL** 管理工业协议点表。维护源数据，通过 SQL 视图计算地址和映射，再生成 AIDC 工程配置。代码、数据迁移和测试均在当前目录。

## 启动

迁移前后可先运行 `./scripts/check-env.sh`，列出工具版本、缺少的前端依赖、浏览器及系统动态库，并提示配置和数据库迁移事项。脚本只检查并给出补齐命令，不自动安装、不连接数据库、不输出密码；发现缺项返回退出码 1。可用 `./scripts/check-env.sh > environment-report.txt` 保存报告，对照新旧机器环境。

数据库初始化、项目创建、应用启动分别执行。新电脑首次部署（Linux x64）：

```bash
./scripts/init-db.sh                 # 初始化本地 PostgreSQL 和表结构，不创建项目
./scripts/create-project.sh upm      # 手动从 config/upm/ 创建 UPM 项目
./scripts/dev.sh
```

打开 http://127.0.0.1:8080 。登录账号和密码对应根目录 `.env` 的 `ADMIN_USERNAME`、`ADMIN_PASSWORD`；首次初始化使用随机密码，没有固定默认口令。`.env` 权限为 `600`，已加入忽略规则。

`init-db.sh` 在 `.runtime/` 内安装、初始化并启动真正的 PostgreSQL 18，使用端口 `55432`，无需 Docker 或系统服务；首次运行生成 `.env`，重复运行保留已有数据库并应用新增迁移。`create-project.sh` 不需要 HTTP 服务已启动，项目由管理员在服务器终端或 SSH 会话中显式创建。`dev.sh` 只构建并启动应用，不启动数据库、不建库、不迁移、不创建项目。

更新代码后若新增数据库迁移，先用 `Ctrl+C` 停止旧 HTTP 服务，再执行以下命令。无需重新创建项目：

```bash
cargo run -- migrate
./scripts/dev.sh
```

只更新前端而仍运行旧后端时，编辑权或权限接口可能返回 404；页面会保持只读并提示升级后端。完成迁移、重启后可点击「重试检查」。

电脑重启后，先启动已有数据库，再启动应用；不必重新创建项目：

```bash
node scripts/local-db.mjs start
./scripts/dev.sh
```

HTTP 服务由 `Ctrl+C` 停止，数据库单独停止：

```bash
node scripts/local-db.mjs stop
```

数据库启动通过 `pg_ctl status` 检查实际进程状态，并等待连接就绪；异常停止后遗留的 `postmaster.pid` 由 PostgreSQL 处理。启动失败时查看 `.runtime/postgres.log`，不需要删除现有数据库目录。未初始化时，启动命令只提示执行初始化脚本，不会隐式创建空库。

**`.runtime/pgdata/` 是真实的持久数据库，不是缓存**：生效拓扑、点表、映射、用户、权限都在这里（使用外部 PostgreSQL 时由外部服务存储）。`.runtime/` 还包含数据库工具、日志和测试截图，整个目录被 Git 忽略。`config/` 保存项目定义；其中的 JSON 描述配置，导出的可选 `project.dump` 携带点表数据。

新电脑执行上面的 UPM 创建命令，会导入项目目录中的 `sources/UPM项目测点数据表.xlsx`，并显示五类板卡。它不会恢复旧电脑网页上保存的后续修改。迁移单个项目可使用下面的文件夹导出与导入；迁移账号、权限和历史版本等整个工作空间时，按 [数据库备份与恢复](docs/operations.md) 操作。

## 按目录创建多个项目

每个项目的配置集中在 `config/<项目名>/`，板卡目录由项目清单指定：

```text
config/
  upm/
    project.json                 项目标识、名称、拓扑、板卡目录和页签顺序
    project.dump                 可选，由项目导出脚本生成的点表数据归档
    CSU/
      process.json               处理点表的完整定义
      collect.json               采集点表的完整定义
      transmit.json              转发点表的完整定义
    UPM/                         同样包含三个表格 JSON
    DSP/
    IDU_T/
    IDU_R/
    sources/
      UPM项目测点数据表.xlsx       可选的创建时导入来源
  project-b/
    project.json
    ...
```

[config/upm/project.json](config/upm/project.json) 的 `key` 必须与项目目录名一致；`name` 是界面显示名，`topology` 保存板卡和协议挂载配置。每个 `topology.board_types` 项的 `directory` 指向项目内的板卡目录，可以与类型 `code` 不同。例如 `code: "DSP"`、`directory: "DSP"` 对应 `config/upm/DSP/`。板卡、表格和来源路径都限制在所属项目内。

CLI 创建优先读取项目 Dump，没有 Dump 时才使用可选 `workbook`；两者都省略时创建空板卡模板。`workbook` 使用项目内相对路径，如 `sources/UPM项目测点数据表.xlsx`。当前 Excel 解析器支持本仓库 UPM 工作簿的结构，不能把任意 Excel 当作通用模板。

复制完整 `upm` 目录到 `project-b`，修改 `key`、`name` 和拓扑，并为各类型配置对应目录；不需要原始点表时删除 `workbook`。然后执行：

```bash
./scripts/create-project.sh project-b
```

创建过程在同一事务中完成，包含拓扑、可选点表导入和审计；失败会整体回滚。已绑定同一 `key` 的项目再次执行会跳过，保留已有数据和 revision；另有同名项目时会报错，避免误覆盖或创建重复项目。脚本使用 `ADMIN_USERNAME` 对应的启用管理员身份，成员权限在网页「成员与权限」分配。创建时有工作簿校验问题会显示数量，进入校验中心处理后才能发布。

网页不提供手工创建拓扑的表单；管理员可以在「项目设置 → 导入项目文件夹」或空项目页选择完整目录。相同 `key` 覆盖已有项目配置，新 `key` 导入为新项目。文件夹包含项目 Dump 时同步替换该项目点表；没有 Dump 时保留已有点表，新项目为空点表，文件夹中的 XLSX 不会自动导入。先查看覆盖范围，再确认提交；最多 512 个文件、总计 64 MiB，预览 30 分钟有效，其他成员正在编辑或预览后版本变化会阻止导入。

导出一个可以直接迁移的项目文件夹：

```bash
node scripts/export-project.mjs upm                  # 默认 .runtime/exports/<时间>/upm/
node scripts/export-project.mjs upm /tmp/project-export
```

导出需要 Node `pg` 驱动、`pg_dump` 和具有创建临时数据库权限的 `MIGRATION_DATABASE_URL`；导入 Dump 需要 `pg_restore`。可在 `.env` 设置 `PG_DUMP_BIN` / `PG_RESTORE_BIN` 的绝对路径。脚本生成真正的 PostgreSQL custom 归档 `project.dump`，并在清单中写入 `"dump": "project.dump"`；网页导入接受这种单项目归档，不接受普通全库备份。未配置 `dump` 时也可识别根目录唯一的 `.dump` 文件。账号、其他项目、历史审计和发布包不随项目归档迁移。

拓扑仍可通过 SSH 修改服务器 `project.json`，网页重新读取、检查并导入。项目、板卡目录和表格定义实时读取，无需重启；表格展示调整刷新页面生效，拓扑修改须校验导入。数据库仍保存 `config_key`、项目记录、板卡模板和 `projects.topology_config` 生效快照，用于关系、权限及版本校验；文件是配置编辑来源，读取文件不会直接替换生效拓扑。

## 功能

- 项目下管理板卡模板与多个板卡实例，配置端点、协议连接、通信地址和设备编码。
- 板卡内用 `(dev_id, sigID)` 关联采集、处理、普通转发和 range；板卡之间使用共享协议契约连接，两端 sigID 独立。
- 共享数据定义、内部类型覆盖、协议类型覆盖、信号范围与恢复策略分别维护。
- 编辑必须先查看关联影响，再提交：显示受影响板卡、信号、协议字段及地址变化。引用删除、冲突、跨项目引用和过期预览会被阻止。
- SQL 自动计算 UPP 模型偏移、Modbus 寄存器地址和透传窗口展开；保留手动地址锚点。
- Excel 预览与原子导入，覆盖已有配置必须明确确认；可查看源单元格与公式。
- 只读 SQL 工作台，限定当前项目、函数/表白名单、3 秒超时、最多 500 行。
- JSON 项目按板卡类型生成协议 JSON/XML，包含项目组成文件；选择 AIDC 目标的模板额外生成采集、处理、转发、range、设备注册等 C 配置。
- 冻结版本、ZIP 下载、源数据快照和审计；后续编辑不改变已发布文件。
- 平台管理员、按项目分配的工程师和只读用户；工程师还可按板卡、具体协议限制编辑范围，使用 PostgreSQL RLS 隔离项目数据。

前端使用 Vue 3 Composition API、TypeScript 和 Vite。「项目拓扑」与「板卡内部信息」是同级页面。拓扑页仅显示 **CSU、UPM、DSP、变压器 IDU、整流模块 IDU 五类板卡**、挂载数量和通信关系，点击任一板卡节点，直接进入该板卡的内部信息；节点也支持 Enter / 空格键操作。点表统一放在「板卡内部信息」，按板卡类型切换；每类只维护一份配置，包括采集、转发、range、协议字段、板间协议及逻辑设备。表头和名称列固定，支持搜索和分页，字号与行距按表格操作调整。

「项目设置」维护共享模板、协议、数据目录和工作簿来源。修改共享数据时，预览列出受影响板卡类型及挂载数量。编辑关联项随类型、端点和逻辑设备联动；校验问题直接跳转到所属板卡的内部信息页。

板卡内部信息按配置直接显示表格，不再区分需要展开的辅助配置。DSP 功率板当前仅展示 **DSP内部数据、转发点表**，其中“DSP内部数据”对应处理点表；其他板卡使用各自项目清单中的页签列表。范围配置统一放在处理点表中，默认展示默认值、上下限、上电恢复默认值和允许手动恢复默认值，不再提供独立范围页签。信号与范围在同一事务中检查并保存，留空覆盖字段可恢复继承。采集、转发表按信号名称展示完整协议映射，支持按逻辑设备筛选及跳转到关联处理点。

## 点表展示配置与接口

点表定义全部位于所属项目的板卡目录，没有公共配置或覆盖层。`PROJECT_CONFIG_DIR` 指定项目目录的父目录，默认 `config`。后端启动及后续读取时检查项目和表格定义；缺少清单、板卡目录、必需表文件或字段元数据会报告具体路径，修正后重新读取。

每个板卡目录必须提供 `process.json`、`collect.json`、`transmit.json`，即使某个表暂时隐藏也保留完整文件。每个文件直接包含以下属性：

| 属性 | 用途 |
| --- | --- |
| `version` | 文件格式版本，填写 `1` |
| `enabled` | 是否显示本板卡的这个表，`false` 隐藏入口 |
| `label` / `description` | 表格名称与说明 |
| `columns` / `editor` | 展示列与完整编辑窗口中的字段顺序 |
| `ordering` | 本表的行排序方式与分组规则 |
| `inline` | 展示列到可写字段的映射，空对象使本表单元格只读 |
| `fields` | 本表完整的字段目录，包括标题、类型、选项、提示及默认值 |

例如，[DSP/process.json](config/upm/DSP/process.json) 将处理点表命名为 `DSP内部数据`；[DSP/collect.json](config/upm/DSP/collect.json) 设置 `enabled: false`，DSP 仍只显示内部数据和转发点表。调整 DSP 的列或字段名称只影响 DSP 的对应表。修改后刷新页面，不需要重启后端或重新编译前端；隐藏表格不删除数据或改变权限。

`project.json` 的 `workspace.boards` 为每个拓扑类型明确指定页签顺序，键对应类型 `code`；`labels` 可设置辅助表标题，业务点表名称由各自文件的 `label` 设置。例如：

```json
{
  "workspace": {
    "boards": {
      "DSP": {
        "tables": ["process", "transmit"]
      }
    }
  }
}
```

此片段只展示 DSP；完整清单须为 `topology.board_types` 中的每个类型提供配置。可用的表格标识如下：

| 表格标识 | 显示内容 |
| --- | --- |
| `process` / `collect` / `transmit` | 处理 / 采集 / 转发点表 |
| `fields` / `data` | 协议字段 / 数据定义 |
| `routes` / `expansion` | 透传路由 / 透传地址 |
| `links` / `endpoints` | 板间协议 / 协议端点 |
| `contexts` / `groups` | 逻辑设备 / 点表分组 |

例如 DSP 需要协议字段时，在 `workspace.boards.DSP.tables` 中加入 `"fields"`。列表控制顺序，单表 `enabled` 控制业务表是否显示：启用且未列出的业务表会按处理、采集、转发的顺序补入；隐藏某个业务表应修改它的 `enabled`。项目文件统一使用 `transmit`，现有 API 的转发标识仍为 `forward`。

要显示处理点被哪些逻辑设备复用，在本表 `columns` 中加入 `contexts`，并保留对应 `fields.contexts` 定义；`range_inherited` 显示范围继承情况。字段的 `label` 控制编辑标题，`column_label` 单独设置显示列标题。上下限、默认值与恢复策略统一在 `process.json` 配置。新增存储属性或协议行为仍需扩展后端字段契约和校验，JSON 配置不会修改数据库结构。这些文件保存显示和编辑规则，业务行与关联仍由 PostgreSQL 保存。

### 按点表分组维护与转发配置

板卡内部信息按 `LOCAL`、`DSP` 等点表分组进入，采集、处理、转发页签保留当前分组；“全部分组”用于汇总查看和跨分组协议排序。分组来自数据库 `signal_groups`，自定义分组显示自己的代码和名称。新增点默认归属当前分组，编辑、切换分组和关闭窗口时检查未保存修改。共用 DSP 点定义与范围的设备在界面及变更预览中列出。

处理点行上的“转发配置”及转发绑定数可以打开该点的全部映射。可以为不同设备上下文、协议字段添加多条映射，与转发点表共用 `signal_bindings`，不复制内部点；来源处理点固定，设备选项仅限使用该组的上下文。新建处理点保存后即可配置转发。表格入口由项目清单的 `workspace` 与单表 `enabled` 控制。

`VIR` 是虚拟转发服务，不是计算点分组。AIDC 板卡存在启用的服务端接口且未配置虚拟上下文时，生成器自动加入 `CFG_DEV_VIR / dev_id=1`，并注册生成的转发表和透传表；自动上下文只出现在生成结果，不写入数据库。已有虚拟上下文保留原编号；默认编号或代码被占用、存在多个虚拟上下文时阻止提交或生成，需调整冲突或显式配置服务。关闭全部服务端接口后不再派生 VIR。`contract` 板卡不生成 AIDC 虚拟设备；计算公式不在此功能范围内。

### 单元格编辑与行排序

处理、采集和转发点表支持直接编辑单元格。单击选择，双击、Enter 或上方「编辑单元格」进入编辑；Tab 切换到下一格，方向键移动选择，Shift 配合点击或方向键选择矩形区域。输入时 Esc 取消当前单元格，Enter 暂存并移到下一行。选中后直接键入文字可替换原值，中文输入框支持输入法组合输入。

板卡切换、分组和工具栏采用紧凑布局，桌面表格填满剩余窗口空间；工具栏的「表格操作说明」提供快捷键帮助。底部分页可选择每页 25、50、100 或 200 条，默认 50 条，按项目、板卡和表格在当前浏览器记住选择。调整每页条数保留草稿和选区，并尽量保持当前记录所在位置。

修改保留在本地草稿，以单元格角标和「行数 / 修改处数」提示；可撤销、重做，也可使用 Ctrl/Cmd+Z。支持从 Excel 等表格粘贴矩形文本，一次最多 200 行；粘贴覆盖当前筛选结果中的已有记录，不自动新增行，任何只读列、无效类型或超出范围都会拒绝整块粘贴。可跨分页粘贴，但不会写入被当前筛选隐藏的行。应用内复制同时携带稳定关联 ID 和范围的继承状态，复制到外部表格则输出可读文本。

点击行号可勾选多条记录，Shift 点击连续选行，表头复选框选择当前页；跨页选择最多 200 行。通过「复制选中行」、行菜单「复制此行」或 Ctrl/Cmd+C 复制；矩形区域也提供「复制选区」按钮。复制按当前可见列与筛选顺序输出，可粘贴到 Excel。整行包含计算列，粘贴回点表前可用列设置仅显示可写列；粘贴仍检查引用、类型和唯一编号。只读用户也能复制。原生剪贴板路径保留关联 ID 与 null 继承元数据，不支持自定义格式的浏览器会回退为可读文本。

点击「检查」单独查看当前草稿的校验结果、项目原有问题及整批关联影响，不提交配置、不释放编辑权，关闭后可继续编辑。点击「检查并保存」重新检查整批关联影响，再「确认提交」一次保存。任意行失败时整批回滚；保存失败、同字段冲突时保留单元格草稿，可返回调整或明确放弃后重新加载。切换板卡、分组、项目或离开页面时检查未保存修改。单元格编辑不会自动写库，排序与单元格草稿分开提交。

`STRING` 类型没有数值上下限：网格显示 `—` 并禁止编辑，记录详情不显示上下限输入；默认字符串和字节长度仍可配置。切换为字符串时，同一次预览会清空该信号的上下限覆盖；共享定义切换会保留显式使用数值内部类型的其他信号范围。后端同样拒绝字符串的非空上下限，SQL 有效视图不再继承这类数值范围。升级迁移不删除历史来源数据。

各表 JSON 的 `inline` 定义展示列与可写字段的对应关系，未配置映射的列保持只读。计算地址、数据长度等继续由关系和 SQL 决定；逻辑设备、处理点、端点和协议字段使用关联下拉选项，更换上游关系会清空不再有效的引用。范围字段留空恢复继承；由公共符号解析的 sigID 通过「记录详情」修改，不直接替换成数字。行号旁的 `⋯` 菜单提供「记录详情」「转发配置」或「关联处理点」入口，完整字段编辑与删除操作保留在详情窗口。只读成员可查看详情、选择和复制表格内容。

表格不再保留右侧操作列，行号与记录菜单固定在左侧，横向滚动时仍可使用。显示列和编辑项由各表 JSON 中的 `columns`、`editor` 控制。分组统一在上方「点表分组」选择，处理点表不再显示重复的分组下拉框；采集、转发有多个逻辑设备时保留设备筛选。

右键列头打开列菜单，可直接隐藏、冻结、左右移动当前列或恢复默认列；「列设置…」打开全部列设置，用于恢复隐藏列以及批量调整显示和顺序。也可聚焦列头后按 Shift+F10，手机端点击列头箭头。冻结列集中在左侧，同类列内可调整顺序；行号始终保留，至少显示一个数据列。菜单操作立即生效，完整列设置窗口点击「应用」后生效。视图设置按项目、板卡和点表保存在当前浏览器，刷新后保留，不改变数据、协议地址、单元格草稿或其他成员的界面；配置新增的列自动加入，已删除的列从视图移除。

拖动第一列手柄调整同组顺序；手柄也支持方向键，点击后可填写组内目标位置跨页移动。排序先暂存，预览确认后保存；取消恢复原顺序。搜索期间禁用排序；按分组或设备筛选后，仅在完整排序组仍可见时允许排序，避免改动隐藏记录。`ordering` 在对应板卡的表格 JSON 中配置，例如转发表的协议排序片段：

```json
{
  "ordering": {
    "mode": "protocol",
    "group_by": ["endpoint_id", "upp_model", "bank"]
  }
}
```

| 模式 | 行为 |
| --- | --- |
| `display` | 保存项目成员共享的显示顺序，保持 sigID、协议地址和固件业务排序；当前三个点表默认使用此模式 |
| `protocol` | 仅转发点表可用，调整共享协议字段的排列并重新计算地址，预览包含所有受影响端点 |
| `disabled` | 禁止手动排序；仍需在完整表定义中显式配置 |

处理点默认按点表分组，采集点按端点与上下文，转发点按端点、UPP 模型和寄存器区分组。`group_by: []` 可将整个表视为一组；`protocol` 必须使用示例中的三个分组字段。协议排序要求组内所有字段各绑定一次，并禁止跨越手动地址锚点；缺失或重复绑定需先整理。

### 独占编辑与提交保护

管理员在「成员与权限 → 编辑范围」配置每位工程师的授权。可选择「项目全部」，或逐板卡勾选「整个板卡」「内部点表」及具体协议。协议授权使用此板卡的协议契约 ID，界面同时显示协议、传输方式和端点；同为 Modbus 的不同契约可分别授权。未授权范围只读，仍可查看、复制和查询。新成员在界面中默认未勾选范围；已有工程师升级后保留原来的全项目权限。

「内部点表」包含内部信号、处理配置、范围及逻辑设备；「具体协议」包含该协议的采集、转发和端点配置。「整个板卡」包含该板卡未来新增的协议。修改共享数据、协议字段或会传递到其他协议的 sigID 时，需要覆盖全部实际影响范围。项目 JSON、整项目导入和版本发布需「项目全部」权限；成员管理始终仅平台管理员可操作。

授权与独占编辑分开检查：有授权的成员仍需点击「开始编辑」。后端在预览和最终提交时重新检查全部变更的原归属、目标归属及 SQL 派生影响，越权返回 `403 / EDIT_SCOPE_DENIED` 并列出缺少的范围，整笔回滚。预览后撤权也不能提交；当前草稿保留。编辑状态轮询同步最新权限，撤销全部编辑范围后租约失效。

同一项目同一时间由一个用户编辑。进入项目先查看，点击「开始编辑」取得编辑权；其他成员看到编辑者姓名，只能查看、复制或调整个人列视图。成功提交配置、导入或发布后立即在同一事务释放编辑权，下一位成员即可取得；预览和失败提交不会释放。「结束编辑」、切换项目或退出登录会主动释放。断开页面后租约在 120 秒内到期，正常打开页面会续租；界面每 5 秒同步状态。弹窗中失去编辑权也可重新获取，已有点表草稿不会因此清空。

编辑权按用户归属，同账户多页面共用编辑权。平台账号和项目成员管理仍按管理员权限单独控制；编辑者被禁用、移除或降为只读后，其租约立即失效。所有项目配置写接口在数据库事务内检查编辑权，未持锁返回 `423 / EDIT_LOCK_REQUIRED`，其他人占用返回 `423 / PROJECT_EDIT_LOCKED`，直接调用 API 同样受此限制。独占锁负责编辑交接，版本与预览校验继续防止旧草稿覆盖交接后的配置。

差异计算和补丁应用直接使用 [json-patch 4.2（MIT / Apache-2.0）](https://github.com/idubrov/json-patch)，事务和回滚使用 SQLx / PostgreSQL。修改提交只包含改变的字段：不同记录或不同字段的修改可以合并；相同字段、同组排序、删除关联对象等冲突返回 `409 / REVISION_CONFLICT`，只回滚失败的提交。单元格草稿在冲突后保留，由用户决定调整或放弃并重新加载；完整设置窗口和排序维持原有冲突后重新加载行为。成功合并会单独提示。

合并不是仅比较版本号：服务端保存预览基线，比较基线、当前数据和待提交补丁，并重新执行业务修改、关联影响检查及校验。如果合并带来原预览之外的变化，或范围、类型、地址等约束不能满足，则拒绝提交。预览前版本已经变化时，客户端可提供 `expected` 原始值；受修改字段仍未变化才允许基于当前数据重新预览。缺少基线时保持严格版本检查。

第一版只自动合并更新和符合规则的排序；新增、删除、整体项目 JSON、工作簿替换和发布继续严格检查版本。生成预览包含 `revision`，创建发布版本必须提交 `{name, revision}`；过期预览需重新生成。预览基线保存在原有预览记录中，15 分钟过期，下次项目预览清理过期记录。

业务接口与数据库实体分离：

| 接口 | 用途 |
| --- | --- |
| `GET /api/projects/{pid}/permissions` | 当前角色、编辑范围和板卡/协议授权目录 |
| `GET /api/projects/{pid}/members` | 成员角色、`edit_scope` 和 `grants` |
| `PUT /api/projects/{pid}/members` | 管理员保存角色与范围；未提供范围字段时保留原授权 |
| `GET /api/projects/{pid}/edit-lock` | 获取持有人、是否本人持锁及到期时间 |
| `POST /api/projects/{pid}/edit-lock/acquire` | 获取项目独占编辑权；请求体 `{}` |
| `POST /api/projects/{pid}/edit-lock/renew` | 为本人编辑权续租；请求体 `{}` |
| `POST /api/projects/{pid}/edit-lock/release` | 主动结束本人编辑；请求体 `{}` |
| `GET /api/project-templates` | 管理自动化使用的项目目录列表，返回 `key`、`name`、`description` 和 `topology` |
| `GET /api/projects/{pid}/configuration/source` | 实时读取当前项目的服务器文件，返回 `key`、`config` 和 `sha256` |
| `GET /api/projects/{pid}/point-tables/schema` | 获取当前项目各板卡的独立展示定义，遵循项目权限 |
| `GET /api/projects/{pid}/board-models/{mid}/point-tables/{kind}` | 获取指定板卡的点表、有效值、原始编辑值和关联选项 |
| `POST /api/projects/{pid}/board-models/{mid}/point-tables/{kind}/preview` | 校验业务修改，预览所有关联影响 |
| `POST /api/projects/{pid}/board-models/{mid}/point-tables/{kind}/batch/preview` | 整批新增或修改，最多 200 行；多行修改以 operation:update 和每行 id/values/expected 提交 |
| `POST /api/projects/{pid}/board-models/{mid}/point-tables/{kind}/reorder/preview` | 提交 `{revision, ids, expected?}`，ids 为一个完整分组的目标顺序，expected 为原顺序 |
| `POST /api/projects/{pid}/changes/{id}/commit` | 检查预览版本，尝试合并无关修改后原子提交 |

`kind` 为 `process`、`collect` 或 `forward`；修改体为 `{revision, operation, id, values, expected?}`。`values` 只提交改变的字段，`expected` 提供原始编辑值，`null` 表示恢复范围继承，省略字段表示保持原值。读接口使用 PostgreSQL 只读一致性快照；写接口检查项目权限、板卡归属、端点角色、协议契约、上下文与信号组匹配。绑定始终引用信号记录 ID，修改 sigID 不改变关系。

## 项目 JSON 配置

[config/upm/project.json](config/upm/project.json) 的 `topology` 定义五种板卡及四条挂载关系：每个 CSU 挂载 24 个 UPM、1 个变压器 IDU、4 个整流模块 IDU；每个 UPM 挂载 8 个 DSP。拓扑按父子关系自动分支，每类只显示一个节点，数量不复制点表或展开成数百个节点。CSU ↔ UPM 同时配置 Modbus / CAN FD 与 UPP / CAN FD；UPM ↔ DSP 为 UPP / CAN；CSU 与两类 IDU 均为 Modbus RTU / RS485。变压器 IDU（`IDU_T`，模板 `IDU_TRANSFORMER`）和整流模块 IDU（`IDU_R`，模板 `IDU_RECTIFIER`）分别维护独立点表；新增模板为空，具体寄存器、地址与内部信号需按实际点表配置。

在服务器编辑 `config/<项目名>/project.json` 的 `topology`，保存后打开网页中的项目配置窗口。窗口只读展示服务器文件，可重新读取最新内容、检查差异并导入数据库；点表内容继续通过网页单元格和记录详情编辑。拓扑导入需要项目全部编辑权限和编辑权，沿用 revision 检查、事务和审计。`board_types[].model_code` 按项目内模板代码关联现有点表，`directory` 指定项目内的板卡配置目录；新增类型时先准备完整板卡目录，再检查导入并建立缺少的空模板。`root` 指定根类型及数量，`mounts[].quantity` 是**每个上级**的挂载数。JSON `version: 2` 使用 `mounts[].connections` 数组保存多组 `{protocol, transport}`，`CANFD` 与 `CAN` 分别表示 CAN FD 和经典 CAN，空数组表示协议待配置；添加协议不会重复计算板卡数量。兼容导入旧版 `version: 1` 的单组 `protocol/transport`（同时为 `null` 表示待配置），应用时转为新版。循环、重复上级、非法数量、与已有端点冲突的协议会被拒绝。

创建项目可使用 `./scripts/create-project.sh <项目目录名>`，或由管理员导入完整项目文件夹。项目配置窗口同步服务器文件中的 `topology`，文件夹导入则覆盖完整配置并按是否包含 Dump 决定是否替换点表。项目、板卡和展示定义实时读取；拓扑经导入后保存到 PostgreSQL 的 `projects.topology_config` 生效快照，点表和权限继续使用关系表。工作簿替换导入保留项目组成，JSON 导出及版本快照包含该配置。

## 工作簿导入范围

逐表追加多条数据请使用 [批量添加步骤、API 与 Node.js Excel 示例](docs/batch-add.md)。示例支持生成模板、查询引用、预览校验和整批提交，单批最多 200 行；通过 `npm ci --prefix scripts/excel-batch` 安装依赖。下述原有 UPM 工作簿导入用于项目整体重建。

| 工作表 | 建模用途 |
| --- | --- |
| DSP内部数据 | 552 条 DSP 源定义；按上传级别筛选出 445 个协议字段 |
| UPM-DSP手动配置数据 | ARM 代理 sigID、标志、轮询、优先级与回调 |
| UPM-DSP采集数据 | 作为投影来源保留；有前两张源表时从源数据重建，不依赖派生缓存 |
| UPM单板测点 | 167 条本地条目；同一信号的多个地址拆成多个协议字段 |
| 平台公共测点映射表 | 公共符号解析 |
| UPM板内Modbus地址分配 | UPM 与 8 个 DSP 实例的地址窗口 |
| CSU、BMS、侦测板相关源表 | 保留原始行，标记待映射 |

工作簿提供 UPM 与 DSP 的点表，以及 UPM 内部面向 8 个 DSP 的采集上下文、UPP 连接和 Modbus→UPP 透传窗口；它们属于 UPM 板内配置，不作为首页的 8 个独立板卡模块。项目整体组成由 JSON 定义。DSP 固件的内部数字 sigID 未在源表中明确，因此不沿用 ARM 的 sigID 推断。

CSU 已有独立类型入口，源工作表尚未映射为 CSU 内部点表；CSU ↔ UPM 已声明两种 CAN FD 协议；原始工作簿中的 UPM 端点仍按来源保留，实际端口与两端协议字段需单独配置。BMS、侦测板的真实端口和连接未明确；HMI 大型派生表未接入。源表中已有的类型/长度、上下限等问题保留在校验中心，阻断错误清理后才能发布。平台没有自动改写原工作簿或 AIDC 参考工程，也未接入钉钉 API。

## 连接已有 PostgreSQL

要求 PostgreSQL **15 或更高版本**（使用 `security_invoker` 视图）。建议部署 PostgreSQL 18。

1. 复制 `.env.example` 到 `.env`，设置数据库地址与随机密码。已有 `.env` 时先保留自己的配置。
2. 使用数据库管理员创建专用账号：

   ```sql
   CREATE DATABASE protocol_studio;
   CREATE ROLE protocol_app LOGIN PASSWORD '替换为随机密码'
     NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
   ```

3. `DATABASE_URL` 使用 `protocol_app`，`MIGRATION_DATABASE_URL` 使用迁移管理员。
4. 运行：

   ```bash
   npm ci --prefix frontend
   npm run build --prefix frontend
   cargo run -- migrate
   cargo run
   ```

迁移会给 `protocol_app` 授予所需权限。迁移账号与运行账号应分开；服务会拒绝超级用户或具有 `BYPASSRLS` 的运行账号。普通运行不会自动迁移数据库。

本地调试前端时另开终端执行 `npm run dev --prefix frontend`，Vite 将 `/api` 代理到 Rust 的 `8080` 端口。

## Docker Compose

已提供 Dockerfile 和 Compose 配置，当前环境没有 Docker，容器构建尚未实测。

在 `.env` 设置 `POSTGRES_PASSWORD`、`POSTGRES_APP_PASSWORD`、`ADMIN_PASSWORD`（建议十六进制随机值，避免数据库 URL 转义问题），然后：

```bash
docker compose up --build -d
```

这是可选容器部署方式，与上述本地脚本独立。依次运行数据库初始化、迁移和应用，不自动创建业务项目。默认只监听本机 `8080`。如需内网访问，设置 `HTTP_BIND=0.0.0.0`。启用 HTTPS 反向代理后设置 `COOKIE_SECURE=true`。

## 测试

```bash
cargo test
npm run build --prefix frontend
node tests/point-grid.mjs
node tests/point-grid-selection.mjs
npm ci --prefix scripts/excel-batch
node --test scripts/excel-batch/workbook.test.mjs
cargo build
node tests/local-db.mjs
node tests/integration.mjs
node tests/migration.mjs
python3 tests/compile-generated.py
```

`tests/local-db.mjs` 使用临时目录和 PostgreSQL 集群，验证首次启动不隐式创建环境/数据库、残留 PID 文件后的恢复、重复启动/停止、连接等待及原数据保留，不操作已有业务数据库。

集成测试读取 `.env` 连接开发 PostgreSQL，创建独立临时数据库和临时 HTTP 服务，测试结束删除临时数据库，不覆盖已有业务项目。它依赖初始化脚本安装的本地 `pg` 客户端及上述 Excel 示例依赖。覆盖显式项目创建、重复/并发创建、导入失败回滚、独立项目及板卡表定义、数据库行级权限、API 权限、SQL 隔离、多人并发合并与冲突回滚、分组排序及共享协议地址、批量追加及 Excel 脚本、导入事务、生成和版本不可变性。`tests/point-editing.mjs` 和 `tests/point-batch.mjs` 由集成入口调用。

C 合约测试编译生成文件并验证设备注册、独立 sigID、别名、地址移动、浮点类型、范围查询及独立恢复策略；使用与参考接口一致的最小类型声明。**这不等于完整固件编译或硬件联调**。参考工程当前缺少独立编译所需的部分驱动头文件，生成代码上线前仍需目标工程验证。

浏览器检查：

```bash
cd frontend
npx playwright install chromium
node browser-check.mjs
```

需要应用已经启动，已导入上述 UPM 项目并配置其拓扑，以及 Chromium 所需系统库和中文字体。检查覆盖拓扑与板卡信息的页面拆分、跳转及板卡切换、五个类型节点、分支布局、同一关系的双 CAN FD 协议及旧版 JSON 兼容、24/8/1/4 挂载数量及两类 IDU 的独立配置、单元格键盘编辑、区域粘贴、撤销重做、保存失败保留草稿、关联下拉、range 继承值、共享修改影响、服务器拓扑读取与差异预览、只读界面及手机布局；也检查来源单元格、SQL 和发布阻断。仅预览配置，提交由测试拦截，不提交业务修改。通过 BASE_URL 可指定服务地址，截图保存在 `.runtime/`。

## 目录

```text
src/                       Rust：认证、API、导入、校验、生成、SQL 防护
migrations/                PostgreSQL 表结构、RLS 策略、SQL 视图和授权
frontend/src/App.vue       Vue 应用和工作空间状态
frontend/src/pages/        各业务页面
frontend/src/components/   通用组件与编辑/导入弹窗
config/                    每项目独立目录、板卡表定义和创建来源
scripts/                   独立的数据库初始化、项目创建和应用启动脚本
tests/                    隔离数据库集成测试与 C 合约测试
docs/                     数据模型与规则说明
```

## 参考

- 本地 `AIDC_CODE/CODE/app/cfg/equip` 的设备、采集、处理、转发、范围表结构及 sig_id 分配约定。
- [codegenerationV2](https://github.com/ryaaaaaan96/codegenerationV2)，参考提交 `2290967aaf2570756abafef4bee6890e72aed4b2` 的字段、文件命名、XML 结构和自动采集 ID 规则。
- [PostgreSQL 行级权限](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)：用于项目级数据访问隔离。

详细规则见 [docs/architecture.md](docs/architecture.md)，备份迁移见 [docs/operations.md](docs/operations.md)。
