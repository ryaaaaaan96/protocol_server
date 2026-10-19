import type { Row } from "../api";
import type { PointKind, PointSchema } from "./pointTables";

export type Sheet = { key: PointKind; label: string; entity: string; pointKind: PointKind };
export const boardSheets: Sheet[] = [
  { key: "process", label: "处理点表", entity: "process_points", pointKind: "process" },
  { key: "forward", label: "转发点表", entity: "transmit_points", pointKind: "forward" },
];
export function configuredBoardSheets(schema: PointSchema, code: string): Sheet[] {
  const board = schema.workspace.boards[code];
  return (board?.tables || []).flatMap(key => {
    const sheet = boardSheets.find(item => item.key === key || item.key === "forward" && key === "transmit");
    const definition = sheet && schema.boards[code]?.[sheet.key];
    return sheet && definition ? [{ ...sheet, label: board?.labels?.[key] ?? definition.label }] : [];
  });
}
export const rows = (graph: Row, table: string): Row[] => graph[table] || [];
export function belongsToBoard(graph: Row, board: Row, entity: string, row: Row): boolean {
  return ["process_points", "transmit_points"].includes(entity) &&
    !!graph.project_config?.board_types?.some((item: Row) => item.code === board.code && item.point_storage === "native") &&
    row.board_key === board.code;
}
export function scopedRows(graph: Row, board: Row | undefined, entity: string, records: Row[]): Row[] {
  return board ? records.filter(record => belongsToBoard(graph, board, entity, record)) : records;
}
