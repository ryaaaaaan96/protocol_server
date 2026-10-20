import type { Row } from "../api";

// One editable object per board type. Quantities describe composition, never UI instances.
export function boardTypes(graph: Row | null): Row[] {
  if (!graph) return [];
  const config = graph.project_config;
  if (!config) return [];
  const roots: Row[] = config.roots || (config.root ? [config.root] : []);
  const counts: Record<string, number> = Object.create(null);
  for (const root of roots) counts[root.type] = root.quantity;
  // Multiple incoming connections reference the same devices. Resolve only
  // after every parent, without adding or multiplying paths through a shared node.
  for (let i = 0; i < config.board_types.length; i++) {
    let progressed = false;
    for (const board of config.board_types) {
      if (counts[board.code] != null) continue;
      const parents = config.mounts.filter((edge: Row) => edge.child === board.code);
      if (!parents.length || parents.some((edge: Row) => counts[edge.parent] == null)) continue;
      const totals = parents.map((edge: Row) => counts[edge.parent] * edge.quantity);
      if (!totals.every((total: number) => total === totals[0])) continue;
      counts[board.code] = totals[0];
      progressed = true;
    }
    if (!progressed) break;
  }
  return config.board_types.map((t: Row) => {
    const parents = config.mounts.filter((e: Row) => e.child === t.code);
    return {
      ...t,
      kind: "type",
      quantity: counts[t.code] || 0,
      parents,
      per_parent: parents[0]?.quantity || counts[t.code] || 0,
      parent: parents.length === 1 ? parents[0].parent : null,
    };
  });
}
// Keep physical composition separate from the protocols used on each relationship.
export function typeMounts(graph: Row): Row[] {
  const types = boardTypes(graph);
  return (graph.project_config?.mounts || []).map((edge: Row, i: number) => ({
    ...edge,
    id: i + 1,
    name: `${edge.parent} ↔ ${edge.child}`,
    connections:
      edge.connections ??
      (edge.protocol && edge.transport
        ? [{ protocol: edge.protocol, transport: edge.transport }]
        : []),
    total: types.find((t) => t.code === edge.child)?.quantity || 0,
  }));
}
