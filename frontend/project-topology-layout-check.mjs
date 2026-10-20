import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import ELK from "elkjs/lib/elk.bundled.js";

async function compiled(name) {
  const source = await readFile(new URL(`./src/domain/${name}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}
const { boardTypes, typeMounts } = await compiled("project");
const { layoutTopology, nodeWidth, nodeHeight } = await compiled("topologyLayout");
const manifest = JSON.parse(await readFile(new URL("../config/dc-ups/project.json", import.meta.url), "utf8"));
const config = manifest.topology;
const graph = { project_config: config };
const before = JSON.stringify(graph);
const engine = new ELK({ algorithms: ["layered"] });
const overlaps = (a, b) => a.x < b.x + b.width - 0.01 && b.x < a.x + a.width - 0.01 && a.y < b.y + b.height - 0.01 && b.y < a.y + a.height - 0.01;
function sampled(points, routing) {
  if (routing === "ORTHOGONAL" || points.length === 2) return points;
  assert.equal((points.length - 1) % 3, 0, "A spline contains complete cubic segments");
  const result = [points[0]];
  for (let i = 1; i < points.length; i += 3) {
    const [start, first, second, end] = points.slice(i - 1, i + 3);
    for (let step = 1; step <= 32; step++) {
      const t = step / 32, s = 1 - t;
      result.push(Object.fromEntries(["x", "y"].map(axis => [axis,
        s ** 3 * start[axis] + 3 * s ** 2 * t * first[axis] + 3 * s * t ** 2 * second[axis] + t ** 3 * end[axis]])));
    }
  }
  return result;
}
function segments(layout) {
  return layout.edges.flatMap(edge => edge.routes.flatMap(route => {
    const points = sampled(route, layout.routing);
    return points.slice(1).map((end, i) => ({ edge, start: points[i], end }));
  }));
}
function verify(layout, direction) {
  assert.equal(layout.nodes.length, config.board_types.length);
  assert.equal(layout.edges.length, config.mounts.length);
  const boxes = layout.nodes.map(node => ({ ...node, width: nodeWidth, height: nodeHeight }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert(!overlaps(boxes[i], boxes[j]), "Cards do not overlap");
  for (const edge of layout.edges) {
    const source = boxes.find(node => node.code === edge.parent), target = boxes.find(node => node.code === edge.child);
    assert(direction === "RIGHT" ? source.x + source.width <= target.x : source.y + source.height <= target.y, "Parent precedes child");
    for (const node of boxes) assert(!overlaps(edge.label, node), "Protocol labels avoid every card");
  }
  for (let i = 0; i < layout.edges.length; i++) for (let j = i + 1; j < layout.edges.length; j++) assert(!overlaps(layout.edges[i].label, layout.edges[j].label), "Protocol labels do not overlap");
  for (const { start, end } of segments(layout)) {
    if (layout.routing === "ORTHOGONAL") assert(start.x === end.x || start.y === end.y, "All segments are orthogonal");
    for (const node of boxes) {
      const through = Math.max(start.x, end.x) > node.x + 0.01 && Math.min(start.x, end.x) < node.x + node.width - 0.01 &&
        Math.max(start.y, end.y) > node.y + 0.01 && Math.min(start.y, end.y) < node.y + node.height - 0.01;
      assert(!through, "Connections never pass through a card");
    }
  }
  let crossings = 0;
  const all = segments(layout);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    if (all[i].edge.id === all[j].edge.id) continue;
    const a = all[i], b = all[j];
    const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    if (cross(a.start, a.end, b.start) * cross(a.start, a.end, b.end) < -1e-7 &&
      cross(b.start, b.end, a.start) * cross(b.start, b.end, a.end) < -1e-7) crossings++;
  }
  assert.equal(crossings, 0, "The DC-UPS sample has no proper edge crossings");
}
for (const direction of ["RIGHT", "DOWN"]) for (const routing of ["SPLINES", "ORTHOGONAL"]) {
  const layout = await layoutTopology(engine, boardTypes(graph), typeMounts(graph), direction, routing);
  verify(layout, direction);
  assert(layout.edges.every(edge => routing === "SPLINES" ? edge.path.includes(" C ") : !edge.path.includes(" C ")), "SVG uses the requested routing style");
  const reversed = structuredClone(graph);
  for (const name of ["board_types", "roots", "mounts"]) reversed.project_config[name].reverse();
  const reordered = await layoutTopology(engine, boardTypes(reversed), typeMounts(reversed), direction, routing);
  const positions = value => value.nodes.map(node => [node.code, node.x, node.y]).sort();
  const routes = value => value.edges.map(edge => [edge.id, edge.path, edge.label]).sort();
  assert.deepEqual(positions(reordered), positions(layout), "JSON array order does not shuffle the diagram");
  assert.deepEqual(routes(reordered), routes(layout), "JSON array order does not shuffle routes or labels");
}
assert.equal(JSON.stringify(graph), before, "Layout never mutates topology data");
console.log("PASS: ELK horizontal/vertical curves and right-angle lines, stable ordering, no card/label overlap and zero crossings for DC-UPS");
