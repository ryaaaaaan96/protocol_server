import ExcelJS from "exceljs";
import { stat, writeFile } from "node:fs/promises";

export const columns = {
  process: ["group_key", "name", "enum_name", "sig_id", "internal_type", "element_count", "unit", "flags", "callback", "process_enabled", "default_value", "min_value", "max_value", "boot_restore", "manual_restore", "notes"],
  forward: ["process_point_id", "endpoint_key", "name", "upp_model", "address", "wire_type", "wire_length", "scale", "access", "byte_order", "conversion", "enabled"],
};
const numbers = new Set(["sig_id", "element_count", "process_point_id", "upp_model", "address", "wire_length", "byte_order"]);
const booleans = new Set(["process_enabled", "boot_restore", "manual_restore", "enabled"]);
const required = {
  process: ["group_key", "name", "enum_name", "internal_type"],
  forward: ["process_point_id", "endpoint_key", "name", "upp_model", "address", "wire_type", "wire_length"],
};
const descriptions = {
  group_key: "project.json 定义的分组代码，例如 LOCAL（必填）",
  name: "点名称（必填）", enum_name: "同板卡唯一的 C 枚举标识符（必填）",
  sig_id: "可选的已确认 DSP sigID，不用采集端编号或行号填充",
  internal_type: "内部类型 U8/U16/S16/U32/S32/F32/STRING（必填）",
  element_count: "元素数量，默认 1；STRING 表示字节容量", unit: "单位", notes: "备注",
  flags: "留空默认 0", callback: "留空默认 NULL", process_enabled: "留空默认 true",
  default_value: "默认值；留空表示未指定", min_value: "数值下限；STRING 不填写",
  max_value: "数值上限；STRING 不填写", boot_restore: "上电恢复；默认 false",
  manual_restore: "手动恢复；默认 false", process_point_id: "当前板卡已有内部点 ID（必填）",
  endpoint_key: "project.json 中的 UPP 端点代码，例如 UPP_SERVICE（必填）",
  upp_model: "UPP 模型号（必填）", address: "显式字节偏移（必填）",
  wire_type: "通信类型 U8/U16/S16/U32/S32/F32/STRING（必填）",
  wire_length: "通信字节长度（必填）", scale: "比例系数，支持小数；默认 1",
  access: "访问属性 RO/WO/RW，默认 RO", byte_order: "字节序，默认 0",
  conversion: "identity/fixed_point/array_bytes；默认 identity", enabled: "启用；默认 true",
};

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

function convert(value, key) {
  if (numbers.has(key)) {
    if (!/^(?:\d+|0x[0-9a-f]+)$/i.test(String(value)) || !Number.isSafeInteger(Number(value))) {
      throw new Error("必须为安全范围内的非负整数，可使用 0x 十六进制");
    }
    return Number(value);
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
  return text;
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
    if (!columns[kind].includes(key)) throw new Error(`表头 ${cell.address}「${key}」不属于 ${kind} 可写字段`);
    if (seen.has(key)) throw new Error(`表头 ${key} 重复`);
    seen.add(key);
    headers.set(col, key);
  });
  for (const key of required[kind]) if (!seen.has(key)) throw new Error(`缺少必填表头 ${key}`);
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
        values[key] = convert(value, key);
      } catch (error) { errors.push(`第 ${rowNumber} 行 ${cell.address}：${error.message}`); }
    });
    if (!populated) return;
    for (const key of required[kind]) {
      if (!Object.hasOwn(values, key)) errors.push(`第 ${rowNumber} 行 ${key}：缺少必填值`);
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
  for (let i = 0; i < columns[kind].length; i++) sheet.getCell(1, i + 1).note = descriptions[columns[kind][i]];
  const help = book.addWorksheet("填写说明");
  help.addRow(["字段", "含义"]);
  for (const key of columns[kind]) help.addRow([key, descriptions[key]]);
  help.addRow(["规则", "第 1 行保留英文字段名，第 2 行开始填数据；仅处理指定工作表，每批最多 200 行。"]);
  help.addRow(["空值", "空单元格省略，采用字段默认值。代码和 ID 请用 --references 查询，不能跨项目复用。"]);
  help.addRow(["添加", "仅新增，不覆盖现有记录；公式先粘贴为值；所有引用必须已存在。"]);
  help.columns = [{ width: 25 }, { width: 100 }];
  await writeFile(file, Buffer.from(await book.xlsx.writeBuffer()), { flag: "wx" });
}
