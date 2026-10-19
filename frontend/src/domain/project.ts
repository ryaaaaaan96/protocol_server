import type { Row } from "../api";

// One editable object per board type. Quantities describe composition, never UI instances.
export function boardTypes(graph: Row | null): Row[] {
  if (!graph) return [];
  const config = graph.project_config;
  if (!config) return [];
  const counts: Record<string, number> = {
    [config.root.type]: config.root.quantity,
  };
  for (let i = 0; i < config.board_types.length; i++)
    for (const edge of config.mounts)
      if (counts[edge.parent] != null)
        counts[edge.child] = counts[edge.parent] * edge.quantity;
  return config.board_types.map((t: Row) => {
    const edge = config.mounts.find((e: Row) => e.child === t.code);
    return {
      ...t,
      kind: "type",
      quantity: counts[t.code] || 0,
      per_parent: edge?.quantity || config.root.quantity,
      parent: edge?.parent || null,
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
