import type { Row } from "../api";

// One editable object per board type. Quantities describe composition, never UI instances.
export function boardTypes(graph: Row | null): Row[] {
  if (!graph) return [];
  const config = graph.project_config;
  if (!config)
    return graph.board_models.map((m: Row) => ({
      id: m.id,
      model_id: m.id,
      model_code: m.code,
      code: m.code,
      name: m.name,
      kind: "type",
      quantity:
        graph.boards.filter((b: Row) => b.model_id === m.id).length || 1,
      per_parent: 1,
      parent: null,
    }));
  const counts: Record<string, number> = {
    [config.root.type]: config.root.quantity,
  };
  for (let i = 0; i < config.board_types.length; i++)
    for (const edge of config.mounts)
      if (counts[edge.parent] != null)
        counts[edge.child] = counts[edge.parent] * edge.quantity;
  return config.board_types.map((t: Row) => {
    const model = graph.board_models.find((m: Row) => m.code === t.model_code),
      edge = config.mounts.find((e: Row) => e.child === t.code);
    return {
      ...t,
      id: model?.id,
      model_id: model?.id,
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
export function typeConnections(graph: Row): Row[] {
  return typeMounts(graph).flatMap((mount) => {
    const connections = mount.connections.length
      ? mount.connections
      : [{ protocol: "待配置", transport: "待配置" }];
    return connections.map((connection: Row, i: number) => ({
      ...mount,
      ...connection,
      id: `${mount.id}:${i}`,
    }));
  });
}
