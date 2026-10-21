import { ApiError, type Row } from "../api";

export type ExportColumn = { key: string; label: string };
export type TableExport = { title: string; columns: ExportColumn[]; rows: Row[]; context: Row };

/** Keep the displayed text, retaining numeric cells where the view shows that number verbatim. */
export function exportCell(value: unknown, text: string): string | number | boolean | null {
  if (value == null && (text === "—" || text === "")) return null;
  if (typeof value === "number" && Number.isFinite(value) && String(value) === text) return value;
  if (typeof value === "boolean" && text === (value ? "是" : "否")) return value;
  return text;
}

export function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadExport(path: string, filename: string, table?: TableExport) {
  const response = await fetch(`/api${path}`, {
    method: table ? "POST" : "GET", credentials: "same-origin",
    headers: { "X-Requested-With": "protocol-studio", ...(table ? { "Content-Type": "application/json" } : {}) },
    body: table ? JSON.stringify(table) : undefined,
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    if (response.status === 401) window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(details.error || `导出失败 (${response.status})`, response.status, details);
  }
  saveFile(await response.blob(), filename);
}
