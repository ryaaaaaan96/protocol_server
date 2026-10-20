import type { Row } from "../api";
import type { PointTableData } from "./pointTables";

/** Flatten server-projected display values. Business addresses are never computed here. */
export function expandedPointTable(source: PointTableData): PointTableData {
  const spec = source.definition.presentation?.row_expansion;
  if (!spec) return source;
  const columns = [...new Set([...spec.leading_columns, ...source.definition.columns])];
  const protectedKeys = new Set(["id", "project_id", "board_key", "group_key", "endpoint_key", "process_point_id", "source_id", "edit_values", "can_edit", "template_id"]);
  const rows: Row[] = [];
  for (const row of source.rows) {
    const instances: unknown = row[spec.field];
    if (!Array.isArray(instances) || !instances.length) throw Error("设备展开数据缺失，请检查表格脚本。");
    for (const values of instances) {
      if (!values || typeof values !== "object" || Array.isArray(values) ||
        Object.entries(values).some(([key, value]) => protectedKeys.has(key) || !columns.includes(key) ||
          (value != null && !["string", "number", "boolean"].includes(typeof value)))) {
        throw Error("设备展开脚本包含无效显示字段。");
      }
      if (rows.length >= 100_000) throw Error("设备展开超过 100000 行，请缩小配置范围。");
      // Negative IDs identify view rows only. Writes always use the original template.
      rows.push({ ...row, ...values, id: -(rows.length + 1), template_id: row.id, can_edit: false, edit_values: {} });
    }
  }
  const compare = new Intl.Collator(undefined, { numeric: true }).compare;
  rows.sort((a, b) => {
    for (const key of spec.leading_columns) {
      const order = compare(String(a[key] ?? ""), String(b[key] ?? ""));
      if (order) return order;
    }
    return 0;
  });
  return { ...source, rows, definition: { ...source.definition, columns, editor: [], inline: {},
    ordering: { mode: "disabled", group_by: [] } } };
}
