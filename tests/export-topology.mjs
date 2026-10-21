import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {comparableTopology} from "../scripts/export-project.mjs";

const source = JSON.parse(readFileSync(new URL("../examples/minimal-project/project.json", import.meta.url))).topology;
source.board_types[0].point_groups[0].devices = [{code:"SENSOR_A", name:"传感器 A", dev_id:10, instance_index:0}];

test("export accepts Rust's explicit default values without modifying input", () => {
  const serialized = structuredClone(source);
  delete serialized.board_types[0].directory;
  serialized.root = null;
  serialized.board_types[0].point_groups[0].devices[0].modbus_base = 0;
  serialized.board_types[0].point_endpoints[1].direction = "transmit";
  const original = structuredClone(source);
  assert.equal(comparableTopology(source), comparableTopology(serialized));
  assert.deepEqual(source, original);
  const v2 = {...structuredClone(source), version:2, root:source.roots[0]};
  delete v2.roots;
  assert.equal(comparableTopology(v2), comparableTopology({...v2, roots:[]}));
  const absentIndex = structuredClone(source);
  delete absentIndex.board_types[0].point_groups[0].devices[0].instance_index;
  const nullIndex = structuredClone(absentIndex);
  nullIndex.board_types[0].point_groups[0].devices[0].instance_index = null;
  assert.equal(comparableTopology(absentIndex), comparableTopology(nullIndex));
});

test("export still rejects real changes to topology and address semantics", () => {
  const changes = [
    config => {config.board_types[0].point_groups[0].devices[0].modbus_base = 100;},
    config => {config.board_types[0].point_groups[0].devices[0].dev_id = 11;},
    config => {config.board_types[0].point_groups[0].devices[0].instance_index = 1;},
    config => {config.board_types[0].point_groups[0].collect_enabled = false;},
    config => {config.board_types[0].point_endpoints[1].protocol = "UPP";},
    config => {config.roots[0].quantity = 2;},
  ];
  for (const change of changes) {
    const modified = structuredClone(source);
    change(modified);
    assert.notEqual(comparableTopology(source), comparableTopology(modified));
  }
});
