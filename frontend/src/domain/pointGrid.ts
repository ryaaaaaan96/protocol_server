import type { Row } from "../api";
import {
  choiceLabel,
  pointChoices,
  pointIsString,
  pointText,
  type PointTableData,
} from "./pointTables";

const MAX_ROWS = 200;
const MAX_COLUMNS = 128;
const PENDING = "待计算";

/** Parse spreadsheet TSV, including quoted tabs/newlines and significant empty cells. */
export function parseClipboard(text: string): string[][] {
  if (text.length > 2 * 1024 * 1024)
    throw new Error("粘贴内容过大，请分批粘贴。");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  let endedWithNewline = false;
  const finishCell = () => {
    row.push(cell);
    if (row.length > MAX_COLUMNS)
      throw new Error(`一次最多粘贴 ${MAX_COLUMNS} 列。`);
    cell = "";
    closed = false;
  };
  const finishRow = () => {
    finishCell();
    rows.push(row);
    if (rows.length > MAX_ROWS)
      throw new Error(`一次最多粘贴 ${MAX_ROWS} 行，请分批操作。`);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    endedWithNewline = false;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else cell += char;
    } else if (char === "\t") {
      finishCell();
    } else if (char === "\r" || char === "\n") {
      finishRow();
      if (char === "\r" && text[i + 1] === "\n") i++;
      endedWithNewline = true;
    } else if (closed) {
      throw new Error("粘贴内容中的引号未正确分隔，请重新从表格复制。");
    } else if (char === '"' && cell === "") {
      quoted = true;
    } else cell += char;
  }
  if (quoted) throw new Error("粘贴内容包含未闭合的引号。");
  // Clipboard exports usually terminate the final record with a newline.
  // Preserve every other empty record and every trailing empty column.
  if (!endedWithNewline) finishRow();
  return rows;
}

export function serializeClipboard(rows: string[][]): string {
  return rows
    .map((row) =>
      (row.length ? row : [""])
        .map((value) =>
          value === "" || /[\t\r\n"]/.test(value)
            ? `"${value.replaceAll('"', '""')}"`
            : value,
        )
        .join("\t"),
    )
    .join("\r\n");
}

export function fieldForColumn(
  data: PointTableData,
  column: string,
): string | undefined {
  const field = data.definition.inline?.[column];
  return field &&
    data.definition.editor.includes(field) &&
    data.definition.fields[field]
    ? field
    : undefined;
}

/** Parse user input without rewriting any dependent fields. */
export function parseCell(
  data: PointTableData,
  key: string,
  text: string | null,
  values: Row,
): unknown {
  const field = data.definition.fields[key];
  if (!field || !data.definition.editor.includes(key))
    throw new Error("此字段不可直接编辑。");
  if (["min_value", "max_value"].includes(key) && pointIsString(data, values)) {
    if (text == null || text.trim() === "") return null;
    throw new Error(`字符串类型不设置上下限，请清空${field.label}。`);
  }
  if (text == null) {
    if (field.nullable) return null;
    throw new Error(`${field.label}不能为空。`);
  }
  const trimmed = text.trim();
  if (field.nullable && text === "") return null;
  if (field.reference) {
    if (!trimmed && field.nullable) return null;
    const choices = pointChoices(data, key, values);
    const select = (matches: Row[]): number | string | undefined => {
      if (matches.length > 1)
        throw new Error(
          `${field.label}存在同名记录，请使用完整选项名称或记录 ID。`,
        );
      return matches[0]?.id;
    };
    const label = select(choices.filter((row) => choiceLabel(row) === trimmed));
    if (label !== undefined) return label;
    const name = select(choices.filter((row) => row.name === trimmed));
    if (name !== undefined) return name;
    if (field.type !== "number") {
      const code = select(choices.filter((row) => String(row.id) === trimmed));
      if (code !== undefined) return code;
    }
    if (/^\d+$/.test(trimmed)) {
      const id = Number(trimmed);
      if (Number.isSafeInteger(id) && choices.some((row) => row.id === id))
        return id;
    }
    throw new Error(
      `${field.label}未匹配到可选记录，请检查上游关联并选择有效选项。`,
    );
  }
  if (field.options) {
    if (!trimmed && field.nullable) return null;
    if (field.options.includes(trimmed)) return field.type === "number" ? Number(trimmed) : trimmed;
    throw new Error(`${field.label}只能选择：${field.options.join("、")}。`);
  }
  if (field.type === "boolean") {
    const input = trimmed.toLowerCase();
    if (["是", "true", "1"].includes(input)) return true;
    if (["否", "false", "0"].includes(input)) return false;
    throw new Error(`${field.label}请输入是 / 否、true / false 或 1 / 0。`);
  }
  if (field.type === "number") {
    if (!trimmed && field.nullable) return null;
    const value = Number(trimmed);
    if (
      !trimmed ||
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    )
      throw new Error(`${field.label}请输入有效数字。`);
    return value;
  }
  return text;
}

/** Project draft values onto the server snapshot; never pretend stale computed values are current. */
export function displayCell(
  data: PointTableData,
  row: Row,
  column: string,
  values: Row,
): string {
  const original = row.edit_values || {};
  // A project can hide fields from its editor. Omission is not a request to
  // clear their values, and must not make unchanged derived columns look dirty.
  values = { ...original, ...values };
  const changed = (...keys: string[]) =>
    keys.some((key) => !Object.is(original[key], values[key]));
  const related = (list: string, key: string) =>
    data.options[list]?.find((item) => item.id === values[key]);
  const projected = (record: Row | undefined, key: string) =>
    record && key in record ? pointText(record[key]) : PENDING;
  const current = () => pointText(row[column]);

  if (["min_value", "max_value"].includes(column) && pointIsString(data, values, row)) return "—";
  if (data.kind === "process") {
    if (column === "group_name" && changed("group_key"))
      return projected(data.options.native_groups?.find(group => group.code === values.group_key), "name");
    if (column === "data_type" && changed("internal_type")) return pointText(values.internal_type);
    if (column === "resolved_sig_id" && changed("sig_id")) return pointText(values.sig_id);
    if (column === "byte_length" && changed("internal_type", "element_count")) {
      const widths: Record<string, number> = { U8: 1, U16: 2, S16: 2, U32: 4, S32: 4, F32: 4, STRING: 1 };
      const width = widths[String(values.internal_type)];
      const count = Number(values.element_count);
      return width && Number.isSafeInteger(count) && count > 0 ? String(width * count) : PENDING;
    }
  } else {
    const signalColumns: Record<string, string> = {
      signal_name: "name", resolved_sig_id: "sig_id", enum_name: "enum_name",
      data_type: "data_type", byte_length: "byte_length", unit: "unit",
    };
    if (signalColumns[column] && changed("process_point_id"))
      return projected(related("process_points", "process_point_id"), signalColumns[column]);
  }
  const key = fieldForColumn(data, column);
  if (key && changed(key)) return pointText(values[key]);
  if (data.definition.editor.includes(column) && changed(column)) return pointText(values[column]);
  return current();
}
