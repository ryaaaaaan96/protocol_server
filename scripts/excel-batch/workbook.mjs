import ExcelJS from "exceljs";
import { stat, writeFile } from "node:fs/promises";

export const columns = {
  // This offline example follows the DSP internal worksheet. Other boards may
  // define a different set of editable fields in their own process.json.
  process: ["name", "variable_name", "sheet_type", "enum_table", "display_digits", "element_count", "default_value", "max_value", "min_value", "unit", "access", "ram", "flash", "eeprom", "calibration", "structure", "cpu", "upload_level", "category", "notes"],
  forward: ["process_point_id", "endpoint_key", "address", "wire_type", "wire_length", "scale", "access"],
};
const legacyProcessColumns = ["group_key", "enum_name", "sig_id", "internal_type", "flags", "callback", "process_enabled", "boot_restore", "manual_restore"];
const legacyForwardColumns = ["name", "enabled", "upp_model", "byte_order", "conversion"];
const numbers = new Set(["sig_id", "display_digits", "element_count", "process_point_id", "upp_model", "address", "wire_length", "byte_order"]);
const booleans = new Set(["process_enabled", "boot_restore", "manual_restore", "enabled"]);
const required = {
  process: [["name"], ["variable_name", "enum_name"], ["sheet_type", "internal_type"]],
  forward: ["process_point_id", "endpoint_key", "address"].map(key => [key]),
};
const dspChoices = {
  sheet_type: ["Sys_U8", "Sys_U16", "Sys_S16", "Sys_U32", "Sys_S32", "Sys_F32"],
  access: ["RO", "RW"],
  ram: ["Y", "N"], flash: ["Y", "N"], eeprom: ["Y", "N"], calibration: ["Y", "N"],
  cpu: ["CPU1", "CPU2"],
  upload_level: ["0：不上传", "1：上传至UPM", "2：UPM进行轮询", "3：CSU进行轮询"],
  category: ["系统参数1", "系统参数2", "任务级观测量", "中断级观测量", "控制参数设置", "任务级标定量"],
};
const descriptions = {
  group_key: "可选的 project.json 分组代码，DSP 默认 LOCAL",
  name: "点名称（必填）", enum_name: "同板卡唯一的 C 枚举标识符（必填）",
  variable_name: "VariateName，原始变量名，例如 ParamProductType；同板卡唯一的 C 标识符（必填）",
  sheet_type: "DateType：Sys_U8/Sys_U16/Sys_S16/Sys_U32/Sys_S32/Sys_F32（必填）",
  enum_table: "EnumTab，枚举或位含义，支持换行",
  display_digits: "DisplayDigit，显示小数位数 0～8，默认 0",
  sig_id: "兼容旧模板的可选字段；DSP 内部数据 sheet 不使用 sigID",
  internal_type: "内部类型 U8/U16/S16/U32/S32/F32/STRING（必填）",
  element_count: "ArrayCnt，元素数量，默认 1", unit: "Unit，单位", notes: "备注",
  flags: "留空默认 0", callback: "留空默认 NULL", process_enabled: "留空默认 true",
  default_value: "默认值；留空表示未指定", min_value: "数值下限；STRING 不填写",
  max_value: "数值上限；STRING 不填写", boot_restore: "上电恢复；默认 false",
  manual_restore: "手动恢复；默认 false", process_point_id: "当前板卡已有内部点 ID（必填）",
  endpoint_key: "project.json 中的 UPP 端点代码，例如 UPP_SERVICE（必填）",
  upp_model: "兼容旧模板；DSP 型号由内部点的数据分类固定推导，填写不同值将拒绝", address: "UPP偏移地址（必填，单位字节）",
  wire_type: "数据类型 U8/U16/S16/U32/S32/F32/STRING；留空采用内部 DateType / ArrayCnt 推导建议，偏离建议时提示",
  wire_length: "UPP协议字节数；留空按所选类型计算", scale: "比例系数，支持小数；留空按转换方式及内部显示精度建议",
  access: "访问属性 RO/WO/RW，默认 RO", byte_order: "兼容旧模板；DSP 不单独配置字节序，规范为 0",
  conversion: "兼容旧模板；DSP 按内部类型与通信类型自动推导", enabled: "兼容旧模板；DSP 转发记录全部参与协议，不能填写 false",
  ram: "RAM：Y/N，默认 N", flash: "FLASH：Y/N，默认 Y",
  eeprom: "EEPROM：Y/N，默认 N", calibration: "Calibration：Y/N，默认 Y",
  structure: "STRUCT，留空表示未指定", cpu: "数据来自CPU：CPU1/CPU2，默认 CPU2",
  upload_level: "数据上传等级：0：不上传 / 1：上传至UPM / 2：UPM进行轮询 / 3：CSU进行轮询；默认 0：不上传",
  category: "数据分类：系统参数1/系统参数2/任务级观测量/中断级观测量/控制参数设置/任务级标定量；可留空",
};

function description(kind, key) {
  return kind === "process" && key === "access" ? "RW：RO/RW，默认 RW" : descriptions[key];
}

function scalar(cell) {
  const value = cell.value;
  if (cell.isMerged) throw new Error("不支持合并单元格，请取消合并");
  if (value !== null && typeof value === "object") {
    // Formula caches may be absent or stale. Do not silently import a cached result.
    throw new Error("仅接受文本、数字、布尔值；公式请先复制并粘贴为值");
  }
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new Error("数值超出安全精度，请使用文本格式");
  }
  return typeof value === "string" ? value.trim() : value;
}

function convert(value, key, kind) {
  if (numbers.has(key)) {
    if (!/^(?:\d+|0x[0-9a-f]+)$/i.test(String(value)) || !Number.isSafeInteger(Number(value))) {
      throw new Error("必须为安全范围内的非负整数，可使用 0x 十六进制");
    }
    const number = Number(value);
    if (key === "display_digits" && number > 8) throw new Error("DisplayDigit 必须为 0～8 的整数");
    return number;
  }
  if (key === "scale") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("比例系数必须为有限数值");
    return number;
  }
  if (booleans.has(key)) {
    if ([true, 1, "1", "true", "TRUE", "是"].includes(value)) return true;
    if ([false, 0, "0", "false", "FALSE", "否"].includes(value)) return false;
    throw new Error("布尔值请填写 true/false、1/0 或 是/否");
  }
  const text = String(value);
  if (Buffer.byteLength(text) > 4096) throw new Error("内容超过 4096 字节");
  if (kind === "process") {
    if (key === "variable_name" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) throw new Error("VariateName 必须为 C 标识符");
    if (dspChoices[key] && !dspChoices[key].includes(text)) throw new Error(`允许的值为 ${dspChoices[key].join(" / ")}`);
  }
  return text;
}

export function withDefinitionDefaults(rows, definition) {
  const aliases = {
    variable_name: "enum_name", enum_name: "variable_name",
    sheet_type: "internal_type", internal_type: "sheet_type",
  };
  return rows.map(row => {
    const values = { ...row.values };
    for (const key of definition?.editor || []) {
      if (Object.hasOwn(values, key) || (aliases[key] && Object.hasOwn(values, aliases[key]))) continue;
      const field = definition.fields?.[key];
      if (field && Object.hasOwn(field, "default")) values[key] = structuredClone(field.default);
    }
    return { ...row, values };
  });
}

export async function readRows(file, kind, sheetName = kind) {
  if (!columns[kind]) throw new Error("kind 必须为 process 或 forward");
  if (!file.toLowerCase().endsWith(".xlsx")) throw new Error("仅支持 .xlsx 文件");
  if ((await stat(file)).size > 15 * 1024 * 1024) throw new Error("文件不能超过 15 MB");
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(file);
  const sheet = book.getWorksheet(sheetName);
  if (!sheet) throw new Error(`找不到工作表「${sheetName}」，可用 --sheet 指定`);
  if (sheet.rowCount > 10000) throw new Error("工作表超过 10000 行，请移除多余空行或拆分文件");
  const headers = new Map(), seen = new Set();
  sheet.getRow(1).eachCell((cell, col) => {
    const key = scalar(cell);
    if (key == null || key === "") return;
    if (!columns[kind].includes(key) && !(kind === "process" && legacyProcessColumns.includes(key)) && !(kind === "forward" && legacyForwardColumns.includes(key))) throw new Error(`表头 ${cell.address}「${key}」不属于 ${kind} 可写字段`);
    if (seen.has(key)) throw new Error(`表头 ${key} 重复`);
    seen.add(key);
    headers.set(col, key);
  });
  for (const keys of required[kind]) if (!keys.some(key => seen.has(key))) throw new Error(`缺少必填表头 ${keys.join(" 或 ")}`);
  const rows = [], errors = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = {};
    let populated = false;
    row.eachCell((cell, col) => {
      try {
        const value = scalar(cell);
        if (value == null || value === "") return;
        populated = true;
        const key = headers.get(col);
        if (!key) throw new Error("此列有数据但没有表头");
        values[key] = convert(value, key, kind);
      } catch (error) { errors.push(`第 ${rowNumber} 行 ${cell.address}：${error.message}`); }
    });
    if (!populated) return;
    for (const keys of required[kind]) {
      if (!keys.some(key => Object.hasOwn(values, key))) errors.push(`第 ${rowNumber} 行 ${keys.join(" 或 ")}：缺少必填值`);
    }
    rows.push({ row: rowNumber, values });
  });
  if (errors.length) throw new Error(errors.slice(0, 50).join("\n") + (errors.length > 50 ? `\n另有 ${errors.length - 50} 项错误` : ""));
  if (!rows.length || rows.length > 200) throw new Error(`每批需要 1～200 行，当前 ${rows.length} 行；请按业务分批，脚本不会自动拆批`);
  return rows;
}

export async function writeTemplate(file, kind) {
  if (!columns[kind]) throw new Error("kind 必须为 process 或 forward");
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(kind, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = columns[kind].map(key => ({ header: key, key, width: 23 }));
  sheet.getRow(1).font = { bold: true };
  for (let i = 0; i < columns[kind].length; i++) sheet.getCell(1, i + 1).note = description(kind, columns[kind][i]);
  const help = book.addWorksheet("填写说明");
  help.addRow(["字段", "含义"]);
  for (const key of columns[kind]) help.addRow([key, description(kind, key)]);
  if (kind === "process") {
    help.addRow(["DSP 示例", "按 DSP内部数据 sheet 的可写字段排列；没有 sigID。其他板卡请以各自配置为准。"]);
    help.addRow(["自动计算", "DataType Length、Total Length、精度由服务端计算；数据类型建议和UPP模型号在内部表隐藏，转发实际类型在 forward 表中单独填写。"]);
    help.addRow(["分组", "DSP 默认使用 LOCAL；需要其他已配置分组时，可自行添加 group_key 列。"]);
  }
  if (kind === "forward") {
    help.addRow(["数据名称", "由关联内部点统一提供，无需另填转发字段名称；所有转发记录参与协议，不提供单独启用开关。"]);
    help.addRow(["分类", "UPP 模型号由关联内部点的数据分类固定推导，无需填写。请先为内部点选择有效分类。"]);
    help.addRow(["建议配置", "wire_type/wire_length/scale 可留空，由服务端成套建议。数据转换由内部与通信类型自动推导，DSP 不单独配置字节序。手工类型偏离建议会提示，仍须通过类型、长度及地址校验。"]);
  }
  help.addRow(["规则", "第 1 行保留英文字段名，第 2 行开始填数据；仅处理指定工作表，每批最多 200 行。"]);
  help.addRow(["空值", "空单元格省略，采用字段默认值。代码和 ID 请用 --references 查询，不能跨项目复用。"]);
  help.addRow(["添加", "仅新增，不覆盖现有记录；公式先粘贴为值；所有引用必须已存在。"]);
  help.columns = [{ width: 25 }, { width: 100 }];
  await writeFile(file, Buffer.from(await book.xlsx.writeBuffer()), { flag: "wx" });
}
