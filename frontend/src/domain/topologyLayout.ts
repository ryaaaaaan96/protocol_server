import type { ELK, ElkNode, ElkPoint } from "elkjs/lib/elk-api";
import type { Row } from "../api";

export type TopologyDirection = "RIGHT" | "DOWN";
export const nodeWidth = 230, nodeHeight = 120;
export interface TopologyLayout {
  nodes: (Row & { x: number; y: number })[];
  edges: (Row & {
    id: string; path: string; labels: string[]; routes: ElkPoint[][];
    label: { x: number; y: number; width: number; height: number };
  })[];
  width: number;
  height: number;
}
const boardId = (code: string) => `board/${code}`;
const edgeId = (edge: Row) => `connection/${edge.parent}/${edge.child}`;
const portId = (edge: Row, side: "out" | "in") => `${edgeId(edge)}/${side}`;
const labelsFor = (edge: Row): string[] => edge.connections.length
  ? edge.connections.map((connection: Row) => `${connection.protocol} / ${connection.transport === "CANFD" ? "CAN FD" : connection.transport}`)
  : ["协议待配置"];
const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// ELK receives only presentation data, in stable order. It never changes the
// input graph, board quantities, protocol settings or persisted project data.
export function layoutInput(boards: Row[], links: Row[], direction: TopologyDirection): ElkNode {
  const ports = new Map<string, NonNullable<ElkNode["ports"]>>(boards.map(board => [board.code, []]));
  for (const link of links) {
    ports.get(link.parent)?.push({ id: portId(link, "out"), width: 0, height: 0,
      layoutOptions: { "elk.port.side": direction === "RIGHT" ? "EAST" : "SOUTH" } });
    ports.get(link.child)?.push({ id: portId(link, "in"), width: 0, height: 0,
      layoutOptions: { "elk.port.side": direction === "RIGHT" ? "WEST" : "NORTH" } });
  }
  return {
    id: "project-topology",
    layoutOptions: {
      "elk.algorithm": "layered", "elk.direction": direction,
      "elk.edgeRouting": "ORTHOGONAL", "elk.randomSeed": "42",
      "elk.padding": "[top=32,left=32,bottom=32,right=32]",
      "elk.spacing.nodeNode": "55", "elk.spacing.edgeEdge": "20",
      "elk.spacing.edgeLabel": "12",
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
    },
    children: boards.map(board => ({
      id: boardId(board.code), width: nodeWidth, height: nodeHeight,
      ports: ports.get(board.code)!.sort(byId),
      layoutOptions: {
        "elk.portConstraints": "FIXED_SIDE",
        ...(!board.parents.length ? { "elk.layered.layering.layerConstraint": "FIRST" } : {}),
      },
    })).sort(byId),
    edges: links.map(link => ({
      id: edgeId(link), sources: [portId(link, "out")], targets: [portId(link, "in")],
      labels: [{ id: `${edgeId(link)}/label`, text: [`× ${link.quantity}`, ...labelsFor(link)].join("\n"),
        width: 152, height: 30 + labelsFor(link).length * 18,
        layoutOptions: { "elk.edgeLabels.placement": "CENTER" } }],
    })).sort(byId),
  };
}

export async function layoutTopology(engine: Pick<ELK, "layout">, boards: Row[], links: Row[], direction: TopologyDirection): Promise<TopologyLayout> {
  const result = await engine.layout(layoutInput(boards, links, direction));
  const nodes = new Map(result.children?.map(node => [node.id, node]));
  const edges = new Map(result.edges?.map(edge => [edge.id, edge]));
  return {
    width: Math.max(900, result.width || 1), height: Math.max(200, result.height || 1),
    nodes: boards.map(board => {
      const node = nodes.get(boardId(board.code));
      if (!node || node.x == null || node.y == null) throw new Error("自动布局未返回完整的板卡位置");
      return { ...board, x: node.x, y: node.y };
    }),
    edges: links.map(link => {
      const edge = edges.get(edgeId(link)), label = edge?.labels?.[0];
      if (!edge?.sections?.length || label?.x == null || label.y == null) throw new Error("自动布局未返回完整的连接位置");
      const routes = edge.sections.map(section => [section.startPoint, ...(section.bendPoints || []), section.endPoint]);
      return { ...link, id: edgeId(link), labels: labelsFor(link), routes,
        path: routes.map(points => points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ")).join(" "),
        label: { x: label.x, y: label.y, width: label.width!, height: label.height! },
      };
    }),
  };
}
