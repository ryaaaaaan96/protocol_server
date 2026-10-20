import type { Row } from "../api";
import { columnApplies, displayCell } from "./pointGrid";
import { hiddenProcessPoint, type PointDefinition, type PointTableData } from "./pointTables";

export type OverviewKind = "process" | "forward";
type PointKind = OverviewKind;
export type OverviewData = { revision: number; process: PointTableData; forward: PointTableData };
export type OverviewRow = { key: string; process: Row; forward?: Row };
export type OverviewDraft = Record<string, Row>;
export const sourceKey = (kind: PointKind, id: number) => `${kind}:${id}`;
export function columnSource(key: string): { kind: PointKind; column: string } {
  const [kind, column] = key.split(":");
  return { kind: kind as PointKind, column };
}
export function overviewRows(data: OverviewData, groupKey?: string, showNonUploaded = false): OverviewRow[] {
  const mappings = new Map<number, Row[]>();
  for (const row of data.forward.rows) {
    const list = mappings.get(row.process_point_id) || [];
    list.push(row);
    mappings.set(row.process_point_id, list);
  }
  return data.process.rows.filter(row => (groupKey == null || row.group_key === groupKey) &&
    (showNonUploaded || !hiddenProcessPoint(data.process.definition, row))).flatMap(process => {
    const linked = mappings.get(process.id);
    return linked?.length
      ? linked.map(forward => ({ key: `${process.id}:${forward.id}`, process, forward }))
      : [{ key: `${process.id}:none`, process }];
  });
}
export function overviewDefinition(data: OverviewData): PointDefinition {
  const internal = data.process.definition.columns
    .filter(key => !data.process.definition.presentation?.overview_hidden_fields?.includes(key));
  const leading = data.process.definition.presentation?.overview_leading_fields?.filter(key => internal.includes(key)) ?? internal;
  const hiddenForward = data.forward.definition.presentation?.overview_hidden_fields || [];
  const forwardColumns = data.forward.definition.columns
    .filter(key => !hiddenForward.includes(key));
  const forwardLeading = data.forward.definition.presentation?.overview_leading_fields?.filter(key => forwardColumns.includes(key)) || [];
  const forward = [...forwardLeading, ...forwardColumns.filter(key => !forwardLeading.includes(key))];
  if (!forward.includes("endpoint_key") && !forward.includes("endpoint_name") &&
    !hiddenForward.includes("endpoint_key") && !hiddenForward.includes("endpoint_name") &&
    data.forward.definition.fields.endpoint_key) forward.push("endpoint_key");
  const columns = [
    ...leading.map(key => `process:${key}`),
    ...forward.map(key => `forward:${key}`),
    ...internal.filter(key => !leading.includes(key)).map(key => `process:${key}`),
  ];
  return {
    label: `${data.process.board_key} 总体视图`, description: "", columns, editor: [], inline: {}, ordering: { mode: "disabled", group_by: [] },
    fields: Object.fromEntries(columns.map(key => {
      const { kind, column } = columnSource(key);
      return [key, data[kind].definition.fields[column] || { label: column }];
    })),
  };
}
export function initialValues(data: PointTableData, row: Row): Row {
  return Object.fromEntries(data.definition.editor.map(key => {
    const field = data.definition.fields[key];
    return [key, Object.hasOwn(row.edit_values, key) ? row.edit_values[key]
      : field.default ?? (field.nullable || field.reference || field.type === "number" ? null : field.type === "boolean" ? false : "")];
  }));
}
export function overviewValues(data: OverviewData, draft: OverviewDraft, kind: PointKind, row: Row): Row {
  return { ...row.edit_values, ...initialValues(data[kind], row), ...draft[sourceKey(kind, row.id)] };
}
export function overviewEntries(data: OverviewData, draft: OverviewDraft) {
  return (["process", "forward"] as const).flatMap(kind => data[kind].rows.flatMap(row => {
    const values = draft[sourceKey(kind, row.id)];
    return values ? [{ kind, id: row.id, values, expected: initialValues(data[kind], row) }] : [];
  })).map((entry, index) => ({ ...entry, row: index + 1 }));
}
export function overviewText(data: OverviewData, draft: OverviewDraft, row: OverviewRow, key: string): string {
  const { kind, column } = columnSource(key), source = row[kind];
  if (!source) return "—";
  const values = overviewValues(data, draft, kind, source);
  if (!columnApplies(data[kind], column, { ...source, ...values }))
    return data[kind].definition.presentation?.empty_text ?? "—";
  if (kind === "forward") {
    const internalDraft = draft[sourceKey("process", row.process.id)] || {};
    if (Object.keys(internalDraft).length && data.forward.definition.presentation?.computed_dependencies?.[column]?.includes("process_point_id"))
      return "待计算";
    // A full-table script may move other rows too; never display old offsets as current.
    if (data.forward.definition.calculation && Object.keys(draft).length &&
      ["effective_address", "effective_length"].includes(column)) return "待计算";
    if (column === "endpoint_key") {
      const key = values.endpoint_key;
      return data.forward.options.endpoints?.find(endpoint => (endpoint.code ?? endpoint.endpoint_key) === key)?.name ?? String(key ?? "—");
    }
  }
  return displayCell(data[kind], source, column, values);
}
