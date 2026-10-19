import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "../frontend/node_modules/typescript/lib/typescript.js";
import {
  effectScope,
  nextTick,
  ref,
} from "../frontend/node_modules/vue/index.mjs";

const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
async function compile(path) {
  return ts.transpileModule(
    await readFile(new URL(path, import.meta.url), "utf8"),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    },
  ).outputText;
}
const tables = moduleUrl(
  await compile("../frontend/src/domain/pointTables.ts"),
);
const domain = moduleUrl(
  (await compile("../frontend/src/domain/pointGrid.ts")).replace(
    '"./pointTables"',
    JSON.stringify(tables),
  ),
);
const source = (await compile("../frontend/src/composables/usePointGrid.ts"))
  .replace(
    '"vue"',
    JSON.stringify(
      new URL("../frontend/node_modules/vue/index.mjs", import.meta.url).href,
    ),
  )
  .replace('"../domain/pointTables"', JSON.stringify(tables))
  .replace('"../domain/pointGrid"', JSON.stringify(domain));
const { usePointGrid } = await import(moduleUrl(source));
const { parseClipboard } = await import(domain);
const definition = JSON.parse(
  await readFile(
    new URL("../config/upm/DSP/process.json", import.meta.url),
    "utf8",
  ),
);
const records = Array.from({ length: 250 }, (_, index) => {
  const edit_values = {
    id: index + 1,
    name: `点 ${index + 1}`,
    board_key: "DSP",
    group_key: "LOCAL",
    enum_name: `POINT_${index + 1}`,
    element_count: 1,
    byte_length: 2,
    sig_id: index + 1,
    internal_type: "U16",
    default_value: "5",
    min_value: null,
    max_value: null,
  };
  return {
    ...edit_values,
    default_value: "5",
    unit: "V",
    group_name: "本机",
    edit_values,
  };
});
const data = ref({
  kind: "process",
  board_key: "DSP",
  storage: "native",
  revision: 1,
  rows: records,
  definition,
  options: {
    native_groups: [{ name: "本机", code: "LOCAL" }],
    process_points: [],
    endpoints: [],
  },
});
const rows = ref(records);
const columns = ref(
  ["name", "default_value", "group_name", "byte_length"].map((key) => ({
    key,
    visible: true,
    frozen: false,
  })),
);
const errors = [];
const scope = effectScope();
const grid = scope.run(() =>
  usePointGrid({
    data,
    scoped: data,
    rows,
    columns,
    page: ref(1),
    writable: () => false,
    blocked: () => false,
    locked: () => false,
    error: (message) => errors.push(message),
  }),
);
const clipboardType = "application/x-protocol-point-cells";
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  execCommand() { return false; },
};
let written;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    clipboard: {
      async write(items) {
        written = items[0].data;
      },
    },
  },
});
globalThis.ClipboardItem = class {
  constructor(data) {
    this.data = data;
  }
};

grid.draft.value = { 2: { name: "尚未保存的改名" } };
grid.undoStack.value = [{}];
assert.equal(grid.selectRow(records[2]), true);
assert.equal(grid.selectRow(records[0]), true);
assert.deepEqual(
  grid.selectedRowIds.value,
  [1, 3],
  "copy order follows the current filter, not click order",
);
assert.equal(
  grid.selected(1, "byte_length"),
  true,
  "row selection includes read-only columns",
);
assert.equal(await grid.copyRows(), true, "viewers can copy");
assert.deepEqual(parseClipboard(await written["text/plain"].text()), [
  ["点 1", "5", "本机 · LOCAL", "2"],
  ["点 3", "5", "本机 · LOCAL", "2"],
]);
let metadata = JSON.parse(await written[`web ${clipboardType}`].text());
assert.deepEqual(metadata.columns, ["name", "default_value", "group_key", null]);
assert.equal(
  metadata.values[0][1],
  "5",
  "copy retains stored values in its typed payload",
);
assert.equal(await grid.copyRows(records[7]), true);
assert.equal(parseClipboard(await written["text/plain"].text())[0][0], "点 8");
assert.deepEqual(
  grid.selectedRowIds.value,
  [1, 3],
  "explicit single-row copy preserves the selection",
);
grid.clearSelection();
assert.deepEqual(grid.draft.value, { 2: { name: "尚未保存的改名" } });
assert.equal(grid.undoStack.value.length, 1);
grid.selectRow(records[2]);
grid.selectRow(records[5], true);
assert.deepEqual(grid.selectedRowIds.value, [3, 4, 5, 6]);
grid.selectRow(records[3]);
assert.deepEqual(grid.selectedRowIds.value, [3, 5, 6]);
grid.clearSelection();
grid.selectRow(records[100]);
grid.selectPage(records.slice(0, 50));
assert.equal(grid.selectedRowIds.value.length, 51);
grid.selectPage(records.slice(0, 50));
assert.deepEqual(
  grid.selectedRowIds.value,
  [101],
  "page deselection preserves other pages",
);
grid.clearSelection();
grid.selectPage(records.slice(0, 200));
assert.equal(grid.selectedRowIds.value.length, 200);
assert.equal(grid.selectRow(records[200]), false);
assert.equal(
  grid.selectedRowIds.value.length,
  200,
  "over-limit selection is atomic",
);
assert.match(errors.at(-1), /200 行/);
rows.value = records.slice(0, 10);
await nextTick();
assert.deepEqual(
  grid.selectedRowIds.value,
  records.slice(0, 10).map((row) => row.id),
);
grid.choose(records[0], "name");
await nextTick();
assert.equal(grid.selectedRowIds.value.length, 0);
grid.choose(records[1], "default_value", true);
await nextTick();
assert.equal(await grid.copySelection(), true);
assert.deepEqual(parseClipboard(await written["text/plain"].text()), [
  ["点 1", "5"],
  ["尚未保存的改名", "5"],
]);
grid.selectRow(records[0]);
grid.selectRow(records[1]);
let native = {};
const event = () => ({
  clipboardData: {
    setData(type, value) {
      native[type] = value;
    },
  },
  preventDefault() {},
  stopImmediatePropagation() {},
});
assert.equal(grid.copy(event()), true);
assert.equal(JSON.parse(native[clipboardType]).values.length, 2);
grid.keydown(
  { ctrlKey: true, key: "c", isComposing: false },
  records[0],
  "name",
);
assert.deepEqual(
  grid.selectedRowIds.value,
  [1, 2],
  "Ctrl+C must not replace selected rows with a cell",
);

let listener;
globalThis.document = {
  addEventListener(type, callback) {
    assert.equal(type, "copy");
    listener = callback;
  },
  removeEventListener() {
    listener = undefined;
  },
  execCommand(command) {
    assert.equal(command, "copy");
    listener(event());
    return true;
  },
};
navigator.clipboard.write = async () => {
  throw new Error("Native copy must run before async clipboard formats");
};
native = {};
assert.equal(await grid.copyRows(records[4]), true);
assert.equal(
  JSON.parse(native[clipboardType]).values[0][0],
  "点 5",
  "event fallback copies the explicit row, not the current selection",
);
document.execCommand = () => false;
let plain;
navigator.clipboard.writeText = async (value) => {
  plain = value;
};
assert.equal(await grid.copySelection(), true);
assert.equal(parseClipboard(plain).length, 2);

grid.editor.value = { id: 1, column: "name" };
grid.input.value = "未确认输入";
navigator.clipboard.writeText = async () => {
  throw new Error("Permission denied");
};
assert.equal(await grid.copyRows(records[0]), false);
assert.match(errors.at(-1), /复制失败/);
assert.deepEqual(
  grid.editor.value,
  { id: 1, column: "name" },
  "failure must preserve the open editor",
);
assert.equal(grid.input.value, "未确认输入");
grid.editor.value = null;
data.value = { ...data.value, revision: 2 };
await nextTick();
assert.equal(grid.selectedRowIds.value.length, 0);
assert.equal(grid.active.value, null);
scope.stop();

// Mixed-permission paste must reject the entire rectangle and preserve drafts
// when an administrator revokes access after an edit has been staged.
const allowedRows = new Set([1]);
const restrictedScope = effectScope();
const restricted = restrictedScope.run(() => usePointGrid({
  data, scoped: data, rows: ref(records.slice(0, 3)), columns, page: ref(1),
  writable: () => true, blocked: () => false, locked: () => false,
  rowWritable: (row, values) => allowedRows.has(row.id) && values.name !== "禁止的目标",
  error: message => errors.push(message),
}));
assert.equal(restricted.editable(records[0], "name"), true);
assert.equal(restricted.editable(records[1], "name"), false);
restricted.choose(records[0], "name");
const pasteRestricted = () => restricted.paste({
  clipboardData: { getData: type => type === "text/plain" ? "已授权的修改\n未授权的修改" : "" },
  preventDefault() {},
});
pasteRestricted();
assert.deepEqual(restricted.draft.value, {}, "a denied later row must not stage the first row");
allowedRows.add(2);
pasteRestricted();
assert.equal(restricted.changedRows.value, 2);
const retained = JSON.stringify(restricted.draft.value);
allowedRows.delete(2);
assert.equal(restricted.entries(), null, "revoked rows cannot enter the save request");
assert.equal(JSON.stringify(restricted.draft.value), retained, "revocation must keep the local draft");
restricted.editor.value = { id: 1, column: "name" };
restricted.input.value = "禁止的目标";
assert.equal(restricted.finish(), false, "destination scope is checked before applying a draft");
assert.equal(JSON.stringify(restricted.draft.value), retained);
restrictedScope.stop();
console.log(
  "Point grid selection, clipboard, scoped paste and draft preservation passed.",
);
