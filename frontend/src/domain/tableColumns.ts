export type TableColumn = { key: string; visible: boolean; frozen: boolean };

export function defaultColumns(keys: string[]): TableColumn[] {
  return keys.map((key, index) => ({ key, visible: true, frozen: index === 0 }));
}

// Keep valid preferences when project configuration adds or removes columns.
export function restoreColumns(keys: string[], saved: unknown): TableColumn[] {
  if (!Array.isArray(saved)) return defaultColumns(keys);
  const remaining = new Set(keys), result: TableColumn[] = [];
  for (const item of saved) {
    if (!item || typeof item !== "object" || !remaining.delete(item.key)) continue;
    result.push({ key: item.key, visible: item.visible !== false, frozen: item.frozen === true });
  }
  result.push(...[...remaining].map(key => ({ key, visible: true, frozen: false })));
  if (result.length && !result.some(c => c.visible)) result[0].visible = true;
  return result;
}

export function orderedColumns(columns: TableColumn[]): TableColumn[] {
  return [...columns.filter(c => c.frozen), ...columns.filter(c => !c.frozen)];
}
