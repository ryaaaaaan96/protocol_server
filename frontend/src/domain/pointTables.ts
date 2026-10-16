import type { Row } from "../api";

export type PointKind = "process" | "collect" | "forward";
export type PointField = {
  label: string;
  column_label?: string;
  type?: "text" | "number" | "boolean";
  reference?: string;
  options?: string[];
  nullable?: boolean;
  default?: unknown;
  hint?: string;
};
export type PointDefinition = {
  label: string;
  description: string;
  columns: string[];
  editor: string[];
  fields: Record<string, PointField>;
  inline: Record<string, string>;
  ordering: { mode: "disabled" | "display" | "protocol"; group_by: string[] };
};
export type PointSchema = {
  tables: Record<PointKind, Omit<PointDefinition, "fields">>;
  workspace?: {
    default_tables: string[];
    boards?: Record<
      string,
      { tables: string[]; labels?: Record<string, string> }
    >;
  };
};
export type PointTableData = {
  revision: number;
  kind: PointKind;
  definition: PointDefinition;
  rows: Row[];
  options: Record<string, Row[]>;
};

export function pointGroupLabel(group: Row): string {
  const names: Record<string, string> = {
    ARM_LOCAL: "LOCAL · 本机数据",
    DSP_LOCAL: "LOCAL · DSP 内部数据",
    DSP_PROXY: "DSP · 下级 DSP 数据",
  };
  return names[group.code] || `${group.code} · ${group.name}`;
}

// All relations refer to stable record IDs. Captions and sigID are display values.
export function pointChoices(
  data: PointTableData,
  key: string,
  values: Row,
): Row[] {
  const field = data.definition.fields[key];
  const all = data.options[field.reference || ""] || [];
  if (key === "endpoint_id")
    return all.filter(
      (e) => e.role === (data.kind === "collect" ? "client" : "server"),
    );
  if (key === "context_id") return all.filter((c) => c.group_id != null);
  if (key === "signal_id") {
    const context = data.options.contexts.find(
      (c) => c.id === values.context_id,
    );
    return context ? all.filter((s) => s.group_id === context.group_id) : [];
  }
  if (key === "field_id") {
    const endpoint = data.options.endpoints.find(
      (e) => e.id === values.endpoint_id,
    );
    return endpoint
      ? all.filter((f) => f.contract_id === endpoint.contract_id)
      : [];
  }
  return all;
}
export function choiceLabel(row: Row): string {
  const detail =
    row.sig_id ??
    row.dev_id ??
    row.effective_address ??
    row.code ??
    row.data_type;
  return `${row.name}${detail == null ? "" : ` · ${detail}`}`;
}
export function pointText(value: unknown): string {
  return value == null
    ? "—"
    : typeof value === "boolean"
      ? value
        ? "是"
        : "否"
      : String(value);
}
