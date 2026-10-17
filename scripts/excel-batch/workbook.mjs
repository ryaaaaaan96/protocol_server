import ExcelJS from "exceljs";
import { stat, writeFile } from "node:fs/promises";

export const columns = {
  process: ["group_id", "data_item_id", "name", "enum_name", "sig_id", "sig_symbol", "internal_type", "flags", "callback", "process_enabled", "default_value", "min_value", "max_value", "boot_restore", "manual_restore"],
  collect: ["endpoint_id", "context_id", "signal_id", "field_id", "poll_interval", "set_priority", "scan_priority"],
  forward: ["endpoint_id", "context_id", "signal_id", "field_id"],
};
const numbers = new Set(["group_id", "data_item_id", "sig_id", "endpoint_id", "context_id", "signal_id", "field_id", "poll_interval", "set_priority", "scan_priority"]);
const booleans = new Set(["process_enabled", "boot_restore", "manual_restore"]);
const required = {
  process: ["group_id", "data_item_id", "name", "enum_name"],
  collect: columns.forward,
  forward: columns.forward,
};
const descriptions = {
  group_id: "当前板卡的点表分组 ID（必填）", data_item_id: "已有数据定义 ID（必填）",
  name: "点名称（必填）", enum_name: "合法 C 枚举标识符（必填）",
  sig_id: "数字 sigID；参与处理表时与 sig_symbol 二选一", sig_symbol: "已有公共 sigID 符号",
  internal_type: "留空继承类型；U8/U16/S16/U32/S32/F32/STRING",
  flags: "留空默认 0", callback: "留空默认 NULL", process_enabled: "留空默认 true",
  default_value: "默认值覆盖；留空继承数据定义", min_value: "下限覆盖；留空继承数据定义",
  max_value: "上限覆盖；留空继承数据定义", boot_restore: "上电恢复；留空默认 false",
  manual_restore: "手动恢复；留空默认 false", endpoint_id: "端点 ID（必填）",
  context_id: "设备上下文 ID（必填）", signal_id: "已有处理点 ID（必填）",
  field_id: "已有协议字段 ID（必填）", poll_interval: "采集周期 0～255；默认 0",
  set_priority: "设置优先级 0～3；默认 0", scan_priority: "扫描优先级 0～1；默认 0",
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
  if (!columns[kind]) throw new Error("kind 必须为 process、collect 或 forward");
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
  if (!columns[kind]) throw new Error("kind 必须为 process、collect 或 forward");
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(kind, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = columns[kind].map(key => ({ header: key, key, width: 23 }));
  sheet.getRow(1).font = { bold: true };
  for (let i = 0; i < columns[kind].length; i++) sheet.getCell(1, i + 1).note = descriptions[columns[kind][i]];
  const help = book.addWorksheet("填写说明");
  help.addRow(["字段", "含义"]);
  for (const key of columns[kind]) help.addRow([key, descriptions[key]]);
  help.addRow(["规则", "第 1 行保留英文字段名，第 2 行开始填数据；仅处理指定工作表，每批最多 200 行。"]);
  help.addRow(["空值", "空单元格省略，采用数据库默认值或数据定义继承值。ID 请用 --references 查询，不能跨项目复用。"]);
  help.addRow(["添加", "仅新增，不覆盖现有记录；公式先粘贴为值；所有引用必须已存在。"]);
  help.columns = [{ width: 25 }, { width: 100 }];
  await writeFile(file, Buffer.from(await book.xlsx.writeBuffer()), { flag: "wx" });
}
