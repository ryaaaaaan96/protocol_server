<script setup lang="ts">
import { computed, ref, watch, nextTick, onBeforeUnmount } from "vue";
import { api, revisionConflict, type Row } from "../api";
import {
  choiceLabel,
  isDspSheet,
  isDspForward,
  communicationFields,
  communicationHint,
  communicationDiffers,
  pointIsString,
  type PointKind,
  type PointTableData,
} from "../domain/pointTables";
import { Search, Plus, ChevronLeft, ChevronRight, GripVertical, Ellipsis, ChevronDown, Undo2, Redo2, Pencil, Check, Copy, CircleHelp } from "@lucide/vue";
import { displayCell } from "../domain/pointGrid";
import { usePointGrid } from "../composables/usePointGrid";
import { pageSizeOptions, usePageSize } from "../composables/usePageSize";
import { usePermissionContext } from "../composables/useProjectPermissions";
import { allowsPoint } from "../domain/permissions";
import Loading from "./Loading.vue";
import Empty from "./Empty.vue";
import PointEditor from "./PointEditor.vue";
import PointColumns from "./PointColumns.vue";
import ContextMenu from "./ContextMenu.vue";
import { defaultColumns, restoreColumns, orderedColumns, type TableColumn } from "../domain/tableColumns";
import PointChangePreview from "./PointChangePreview.vue";
import Modal from "./Modal.vue";
const props = defineProps<{
  pid: number;
  boardKey: string;
  kind: PointKind;
  label: string;
  revision: number;
  canWrite: boolean;
  focusId?: number;
  groupKey?: string;
  endpointKey?: string;
  processPointId?: number;
  allowForward?: boolean;
  forwardLabel?: string;
}>();
const emit = defineEmits<{
  done: [merged?: boolean];
  conflict: [];
  process: [id: number];
  error: [message: string];
  dirty: [value: boolean];
}>();
const data = ref<PointTableData | null>(null),
  error = ref(""),
  query = ref(""),
  page = ref(1);
const showHelp = ref(false);
const permissions = usePermissionContext();
function scopeEditable(row?: Row | null, values?: Row) {
  return !!data.value && allowsPoint(permissions.state.value, props.boardKey, props.kind, data.value,
    row && values ? { ...row, edit_values: { ...row.edit_values, ...values } } : row);
}
const canEditTable = computed(() => props.canWrite && scopeEditable());
const editing = ref(false),
  selected = ref<Row | null>(null);
const reload = ref(0);
const editorDirty = ref(false), forwardDirty = ref(false), forwardSignal = ref<Row | null>(null);
const orderDraft = ref<{key: string; ids: number[]; original: Row[]} | null>(null);
const moving = ref<Row | null>(null), movePosition = ref(1), dragging = ref<Row | null>(null);
const dropId = ref<number>(), review = ref<Row | null>(null), busy = ref(false), actionError = ref("");
const reviewMode = ref<"check" | "save">("save");
const gridDirty = ref(false);
const dirty = computed(() => !!orderDraft.value || editorDirty.value || forwardDirty.value || gridDirty.value);
watch(dirty, value => emit("dirty", value), {flush:"sync"});
onBeforeUnmount(() => emit("dirty", false));
watch(
  () => [
    props.pid, props.boardKey, props.kind, props.endpointKey, props.label, props.revision, reload.value,
  ],
  async (_, __, cleanup) => {
    let cancelled = false;
    cleanup(() => {
      cancelled = true;
    });
    data.value = null;
    error.value = "";
    editing.value = false;
    orderDraft.value = null;
    moving.value = null;
    review.value = null;
    actionError.value = "";
    try {
      const result = await api(
        `/projects/${props.pid}/boards/${encodeURIComponent(props.boardKey)}/point-tables/${props.kind}`,
      );
      if (!cancelled) {
        result.definition.label = props.label;
        if (props.endpointKey) {
          const protocol = result.options.endpoints.find((endpoint: Row) => endpoint.code === props.endpointKey)?.protocol;
          const excluded = protocol === "MODBUS" ? ["upp_model"] : ["register_type", "register_count"];
          result.definition.columns = result.definition.columns.filter((key: string) => !excluded.includes(key));
          result.definition.editor = result.definition.editor.filter((key: string) => !excluded.includes(key));
          result.definition.inline = Object.fromEntries(Object.entries(result.definition.inline).filter(([key]) => !excluded.includes(key)));
        }
        data.value = result;
      }
    } catch (e) {
      if (!cancelled) error.value = (e as Error).message;
    }
  },
  { immediate: true },
);
watch(
  () => [data.value, props.focusId],
  () => {
    const row = data.value?.rows.find((r) => r.id === props.focusId);
    if (row) open(row);
  },
);
const def = computed(() => data.value?.definition);
const categoryFilter = ref<string | null>(null);
const classified = computed(() => !!data.value && isDspForward(data.value));
watch(data, () => { categoryFilter.value = null; });
const columnSettings = ref(false), columns = ref<TableColumn[]>([]);
const columnKey = computed(() => {
  const base = `point-columns:${props.pid}:${encodeURIComponent(props.boardKey)}:${props.kind}${props.endpointKey ? `:${encodeURIComponent(props.endpointKey)}` : ""}`;
  return data.value && (isDspSheet(data.value) || isDspForward(data.value))
    ? `${base}:layout:${encodeURIComponent(JSON.stringify(data.value.definition.columns))}` : base;
});
const { pageSize, setPageSize } = usePageSize(computed(() => `point-page-size:${props.pid}:${encodeURIComponent(props.boardKey)}:${props.kind}`));
const displayColumns = computed(() => orderedColumns(columns.value).filter(c => c.visible));
watch([() => def.value?.columns, columnKey], ([keys]) => {
  if (!keys) return;
  let saved: unknown;
  try { saved = JSON.parse(localStorage.getItem(columnKey.value) || "null"); } catch {}
  columns.value = restoreColumns(keys, saved);
}, { immediate: true });
function applyColumns(settings: TableColumn[]) {
  if (!grid.finish()) return;
  columns.value = restoreColumns(def.value!.columns, settings);
  columnSettings.value = false;
  try { localStorage.setItem(columnKey.value, JSON.stringify(columns.value)); }
  catch { emit("error", "列设置已应用，但浏览器未能保存；刷新后会恢复默认。"); }
}
const tableHead = ref<HTMLElement>(), frozenLeft = ref<Record<string, number>>({});
function measureColumns() {
  const head = tableHead.value;
  if (!head) return;
  let left = head.querySelector(".row-number")?.getBoundingClientRect().width || 0;
  const offsets: Record<string, number> = {};
  for (const column of displayColumns.value.filter(c => c.frozen)) {
    offsets[column.key] = left;
    const cell = [...head.querySelectorAll<HTMLElement>("[data-column-key]")].find(el => el.dataset.columnKey === column.key);
    left += cell?.getBoundingClientRect().width || 0;
  }
  if (JSON.stringify(offsets) !== JSON.stringify(frozenLeft.value)) frozenLeft.value = offsets;
}
watch([tableHead, displayColumns], async (_, __, cleanup) => {
  let cancelled = false;
  let observer: ResizeObserver | undefined;
  cleanup(() => { cancelled = true; observer?.disconnect(); });
  await nextTick();
  if (cancelled || !tableHead.value) return;
  observer = new ResizeObserver(measureColumns);
  for (const cell of tableHead.value.querySelectorAll("th")) observer.observe(cell);
  measureColumns();
}, { flush: "post" });
const scopedData = computed<PointTableData | null>(() => {
  if (!data.value) return null;
  const options = { ...data.value.options };
  if (props.groupKey != null) {
    options.native_groups = (options.native_groups || []).filter(group => group.code === props.groupKey);
    options.process_points = (options.process_points || []).filter(signal => signal.group_key === props.groupKey);
  }
  if (props.endpointKey) options.endpoints = (options.endpoints || []).filter(endpoint => endpoint.code === props.endpointKey);
  if (props.kind === "collect") options.process_points = options.process_points.filter(point => point.group_key !== "LOCAL");
  if (props.processPointId != null) options.process_points = options.process_points.filter(s => s.id === props.processPointId);
  return { ...data.value, options };
});
function inScope(row: Row) {
  return (!props.endpointKey || row.endpoint_key === props.endpointKey) && (props.processPointId == null || row.process_point_id === props.processPointId) &&
    (props.groupKey == null || (row.group_key ?? row.edit_values?.group_key ??
      data.value?.options.process_points.find(point => point.id === row.process_point_id)?.group_key) === props.groupKey);
}
const indexed = computed(() =>
  (data.value?.rows || []).map((row) => ({
    row,
    search: def
      .value!.columns.map((key) => displayCell(data.value!, row, key, row.edit_values || {}))
      .join(" ")
      .toLowerCase(),
  })),
);
const matched = computed(() =>
  indexed.value
    .filter(
      ({ row, search }) =>
        inScope(row) &&
        search.includes(query.value.trim().toLowerCase()),
    )
    .map(({ row }) => row),
);
function categoryOf(row: Row): string {
  return String(row.category ?? data.value?.options.process_points?.find(point => point.id === row.process_point_id)?.category ?? "");
}
const categories = computed(() => {
  const counts = new Map<string, number>();
  for (const row of matched.value) counts.set(categoryOf(row), (counts.get(categoryOf(row)) || 0) + 1);
  return [...counts].map(([key, count]) => ({ key, label: key || "未分类", count }));
});
const filtered = computed(() => matched.value.filter(row => !classified.value || categoryFilter.value == null || categoryOf(row) === categoryFilter.value));
const pages = computed(() =>
  Math.max(1, Math.ceil(filtered.value.length / pageSize.value)),
);
const visible = computed(() =>
  filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value),
);
const grid = usePointGrid({
  data, scoped: scopedData, rows: filtered, columns: displayColumns, page, pageSize,
  writable: () => canEditTable.value,
  rowWritable: (row, values) => scopeEditable(row) && scopeEditable(row, values),
  allowedChoice: (row, key, choice, values) => key !== "endpoint_key" || scopeEditable(row, { ...values, endpoint_key: choice.id }),
  blocked: () => busy.value || !!review.value || !!orderDraft.value,
  locked: key => (key === "endpoint_key" && props.endpointKey != null) || (key === "group_key" && props.groupKey != null) ||
    (key === "process_point_id" && props.processPointId != null),
  error: message => { actionError.value = message; },
});
const gridTable = grid.table, gridInput = grid.input;
function selectCategory(category: string | null) {
  if (busy.value || review.value || orderDraft.value || !grid.finish()) return;
  categoryFilter.value = category;
  page.value = 1;
  grid.clearSelection();
}
const gridEditorDef = computed(() => grid.editorDefinition.value || null);
const draftWithinScope = computed(() => Object.keys(grid.draft.value).every(id => {
  const row = data.value?.rows.find(item => item.id === Number(id));
  return !!row && scopeEditable(row) && scopeEditable(row, grid.values(row));
}));
const orderWithinScope = computed(() => !orderDraft.value || orderDraft.value.ids.every(id => {
  const row = data.value?.rows.find(item => item.id === id);
  return !!row && scopeEditable(row);
}));
watch(grid.dirty, value => { gridDirty.value = value; }, { flush: "sync" });
const copyFeedback = ref("");
const pageSelected = computed(() => visible.value.length > 0 && visible.value.every(row => grid.isRowSelected(row.id)));
const pagePartSelected = computed(() => !pageSelected.value && visible.value.some(row => grid.isRowSelected(row.id)));
const selectionLabel = computed(() => {
  if (grid.selectedRowIds.value.length) return `已选择 ${grid.selectedRowIds.value.length} 行`;
  const selection = grid.selection.value;
  return selection ? `已选择 ${selection.lastRow - selection.firstRow + 1} 行 × ${selection.lastColumn - selection.firstColumn + 1} 列` : "";
});
async function copyGrid(row?: Row) {
  if (!grid.finish()) return;
  const success = row ? await grid.copyRows(row) : await grid.copySelection();
  if (success) copyFeedback.value = row ? "已复制此行，可粘贴到 Excel 或其他表格。" : "已复制所选内容，可粘贴到 Excel 或其他表格。";
}
function selectPage(event: Event) {
  grid.selectPage(visible.value);
  const checkbox = event.target as HTMLInputElement;
  checkbox.checked = pageSelected.value;
  checkbox.indeterminate = pagePartSelected.value;
}
function changePageSize(event: Event) {
  const select = event.target as HTMLSelectElement;
  const size = Number(select.value);
  if (busy.value || review.value || !grid.finish()) {
    select.value = String(pageSize.value);
    return;
  }
  const firstRow = (page.value - 1) * pageSize.value;
  const activeRow = filtered.value.findIndex(row => row.id === grid.active.value?.id);
  const anchor = activeRow >= firstRow && activeRow < firstRow + pageSize.value ? activeRow : firstRow;
  if (setPageSize(size)) page.value = Math.min(pages.value, Math.floor(anchor / size) + 1);
  select.value = String(pageSize.value);
}
watch([grid.selectedRowIds, grid.active, grid.changedCells], () => { copyFeedback.value = ""; });
type TableMenu = { x: number; y: number; serial: number } & (
  { type: "column"; key: string } | { type: "row"; row: Row }
);
const tableMenu = ref<TableMenu | null>(null);
let menuSerial = 0;
const columnLabel = (key: string) => def.value!.fields[key].column_label || def.value!.fields[key].label;
const menuLabel = computed(() => tableMenu.value?.type === "column" ? `${columnLabel(tableMenu.value.key)}列菜单` : "记录操作");
function columnNeighbor(key: string, step: number) {
  const index = displayColumns.value.findIndex(c => c.key === key);
  const current = displayColumns.value[index], neighbor = displayColumns.value[index + step];
  return current && neighbor?.frozen === current.frozen ? neighbor : undefined;
}
const menuItems = computed(() => {
  const menu = tableMenu.value;
  if (!menu) return [];
  if (menu.type === "row") {
    return [
      { key: "detail", label: "记录详情" },
      { key: "copy-row", label: "复制此行" },
      ...(grid.selectedRowIds.value.length ? [{ key: "copy-rows", label: "复制选中行" }] : []),
      ...(props.kind === "process" && props.allowForward ? [{ key: "forward", label: "转发配置" }] : []),
      ...(props.kind !== "process" && props.processPointId == null ? [{ key: "process", label: "关联处理点" }] : []),
    ];
  }
  const column = columns.value.find(c => c.key === menu.key)!;
  return [
    { key: "freeze", label: column.frozen ? "取消冻结" : "冻结到左侧" },
    { key: "hide", label: "隐藏此列", disabled: displayColumns.value.length <= 1 },
    { key: "left", label: "向左移动", disabled: !columnNeighbor(menu.key, -1) },
    { key: "right", label: "向右移动", disabled: !columnNeighbor(menu.key, 1) },
    { key: "columns", label: "列设置…", separator: true },
    { key: "reset", label: "恢复默认列" },
  ];
});
function menuPosition(event: MouseEvent | KeyboardEvent) {
  const target = event.currentTarget as HTMLElement;
  target.focus({ preventScroll: true });
  const rect = target.getBoundingClientRect();
  return event instanceof MouseEvent && event.type === "contextmenu" && (event.clientX || event.clientY)
    ? { x: event.clientX, y: event.clientY }
    : { x: rect.left, y: rect.bottom };
}
function openColumnMenu(key: string, event: MouseEvent | KeyboardEvent) {
  if (busy.value || review.value || !grid.finish()) return;
  tableMenu.value = { ...menuPosition(event), serial: ++menuSerial, type: "column", key };
}
function columnKeydown(key: string, event: KeyboardEvent) {
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault();
    openColumnMenu(key, event);
  }
}
function openRowMenu(row: Row, event: MouseEvent) {
  if (busy.value || review.value || !grid.finish()) return;
  tableMenu.value = { ...menuPosition(event), serial: ++menuSerial, type: "row", row };
}
function menuAction(action: string) {
  const menu = tableMenu.value;
  tableMenu.value = null;
  if (!menu || busy.value || review.value) return;
  if (menu.type === "row") {
    if (action === "detail") open(menu.row);
    else if (action === "copy-row") void copyGrid(menu.row);
    else if (action === "copy-rows") void copyGrid();
    else if (action === "forward") openForward(menu.row);
    else if (action === "process" && discard()) emit("process", menu.row.process_point_id);
    return;
  }
  if (action === "columns") { columnSettings.value = true; return; }
  const next = columns.value.map(c => ({ ...c }));
  const column = next.find(c => c.key === menu.key)!;
  if (action === "freeze") column.frozen = !column.frozen;
  else if (action === "hide" && displayColumns.value.length > 1) column.visible = false;
  else if (action === "reset") { applyColumns(defaultColumns(def.value!.columns)); return; }
  else if (action === "left" || action === "right") {
    const neighbor = columnNeighbor(menu.key, action === "left" ? -1 : 1);
    if (!neighbor) return;
    const from = next.indexOf(column), to = next.findIndex(c => c.key === neighbor.key);
    next.splice(from, 1);
    next.splice(to, 0, column);
  } else return;
  applyColumns(next);
  if (action === "hide") void nextTick(() => tableHead.value?.querySelector<HTMLElement>("th[data-column-key]")?.focus({ preventScroll: true }));
}
watch([data, page, pageSize, query, displayColumns, busy, review], () => { tableMenu.value = null; });
function cellHint(row: Row, column: string) {
  const key = grid.field(column);
  if (data.value && isDspForward(data.value) && key && communicationFields.some(field => field === key))
    return communicationHint(data.value, grid.values(row), row);
  if (["min_value", "max_value"].includes(column) && pointIsString(data.value!, grid.values(row), row)) return "字符串没有数值上下限，长度由字节数管理。";
  if (!props.canWrite) return "当前项目为只读权限，可选中和复制单元格。";
  if (!scopeEditable(row)) return "未获此板卡或协议的编辑权限，可以查看和复制；请联系管理员授权。";
  if (!key) return "关联或计算字段，随来源数据更新。";
  if (!grid.editable(row, column)) return "此字段在当前分组中锁定，可通过记录详情查看。";
  return `${def.value!.fields[key].hint || "双击或按 Enter 编辑"}${def.value!.fields[key].multiline ? "；Shift+Enter 换行" : ""}${def.value!.fields[key].nullable ? "；留空表示未指定" : ""}`;
}
function discardGrid() {
  if (grid.dirty.value && !window.confirm("放弃这些尚未保存的单元格修改？")) return;
  grid.reset();
  actionError.value = "";
}
async function previewGrid(mode: "check" | "save") {
  if (!canEditTable.value || !draftWithinScope.value || busy.value || review.value || !data.value) return;
  const rows = grid.entries();
  if (!rows?.length) return;
  for (const row of rows) {
    for (const [key, value] of Object.entries(row.values)) {
      const field = def.value!.fields[key];
      if ((field.reference && !field.nullable && value == null) || (["name", "enum_name", "variable_name"].includes(key) && !String(value ?? "").trim())) {
        actionError.value = `第 ${row.row} 行「${field.label}」不能为空，请补全后重新检查。`;
        return;
      }
    }
  }
  reviewMode.value = mode;
  busy.value = true;
  actionError.value = "";
  try {
    review.value = await api(`/projects/${props.pid}/boards/${encodeURIComponent(props.boardKey)}/point-tables/${props.kind}/batch/preview`, "POST", {
      revision: data.value.revision, operation: "update", rows,
    });
  } catch (e) {
    actionError.value = (e as Error).message;
    emit("error", actionError.value);
  } finally { busy.value = false; }
}
function previewConflict() {
  if (grid.changedRows.value) {
    review.value = null;
    actionError.value = "其他成员修改了相同字段或关联数据，本次修改尚未保存。草稿已保留，可复制修改内容，或重新载入最新数据。";
  } else conflict();
}
watch([query], () => {
  page.value = 1;
});
watch(pages, (n) => {
  page.value = Math.min(page.value, n);
});
function open(row: Row | null) {
  if (!discard()) return;
  selected.value = row;
  editing.value = true;
}
function openForward(row: Row) {
  if (!discard()) return;
  forwardSignal.value = row;
}
function closeForward() {
  if (forwardDirty.value && !window.confirm("有未保存的修改，是否放弃？")) return;
  forwardSignal.value = null;
  forwardDirty.value = false;
}
function discard() {
  if (dirty.value && !window.confirm("有未保存的修改，是否放弃？")) return false;
  cancel();
  return true;
}
function cancel() {
  if (data.value && orderDraft.value) data.value.rows = orderDraft.value.original;
  orderDraft.value = null;
  moving.value = null;
  dragging.value = null;
  dropId.value = undefined;
  actionError.value = "";
  grid.reset();
}
const orderEnabled = computed(() => canEditTable.value && def.value?.ordering.mode !== "disabled");
const canReorder = computed(() => orderEnabled.value && !query.value.trim() && !busy.value && !gridDirty.value);
function orderGroupKey(row:Row) { return JSON.stringify(def.value!.ordering.group_by.map(key => row[key] ?? 0)); }
function groupRows(row:Row) { return data.value!.rows.filter(r => orderGroupKey(r) === orderGroupKey(row)); }
const filteredIds = computed(() => new Set(filtered.value.map(r => r.id)));
function canMove(row:Row) {
  const members = groupRows(row);
  return canReorder.value && (!orderDraft.value || orderDraft.value.key === orderGroupKey(row)) &&
    members.length > 1 && members.every(r => filteredIds.value.has(r.id) && scopeEditable(r));
}
function move(row:Row, position:number) {
  if (!canMove(row) || !Number.isInteger(position)) return;
  const group = groupRows(row), from = group.findIndex(r => r.id === row.id);
  if (position < 1 || position > group.length || from === position-1) return;
  const original = orderDraft.value?.original || [...data.value!.rows];
  const [item] = group.splice(from,1);
  group.splice(position-1,0,item);
  let index = 0;
  data.value!.rows = data.value!.rows.map(r => orderGroupKey(r) === orderGroupKey(row) ? group[index++] : r);
  const same = original.every((r,i) => r.id === data.value!.rows[i].id);
  orderDraft.value = same ? null : {key:orderGroupKey(row),ids:group.map(r => r.id),original};
  moving.value = null;
  actionError.value = "";
}
function startDrag(row:Row, event:DragEvent) {
  if (!canMove(row)) {event.preventDefault(); return;}
  dragging.value = row;
  event.dataTransfer?.setData("text/plain",String(row.id));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}
function dragOver(row:Row, event:DragEvent) {
  if (dragging.value && canMove(row) && orderGroupKey(row) === orderGroupKey(dragging.value)) {
    event.preventDefault(); dropId.value = row.id;
  }
}
function drop(row:Row, event:DragEvent) {
  event.preventDefault();
  if (dragging.value && orderGroupKey(row) === orderGroupKey(dragging.value)) move(dragging.value,groupRows(row).findIndex(r => r.id === row.id)+1);
  dragging.value = null; dropId.value = undefined;
}
function choosePosition(row:Row) {
  moving.value = row;
  movePosition.value = groupRows(row).findIndex(r => r.id === row.id)+1;
}
async function previewChange() {
  if (!canEditTable.value || !data.value || !orderDraft.value || busy.value || review.value) return;
  if (!orderWithinScope.value) {
    actionError.value = "排序涉及未授权的板卡或协议，当前不能保存；修改仍保留。";
    return;
  }
  reviewMode.value = "save";
  busy.value = true;
  actionError.value = "";
  try {
    const base = `/projects/${props.pid}/boards/${encodeURIComponent(props.boardKey)}/point-tables/${props.kind}`;
    review.value = await api(`${base}/reorder/preview`, "POST", {
      revision: data.value.revision,
      ids: orderDraft.value.ids,
      expected: orderDraft.value.original.filter(r => orderGroupKey(r) === orderDraft.value!.key).map(r => r.id),
    });
    if (review.value && !review.value.allowed) emit("error", review.value.errors.map((e:Row) => e.message).join("；") || "关联检查未通过");
  } catch(e) {
    actionError.value = (e as Error).message;
    emit("error", actionError.value);
    if (revisionConflict(e)) conflict();
  }
  finally { busy.value = false; }
}
async function previewCalculation() {
  if (!data.value || !canEditTable.value || dirty.value || busy.value || review.value) return;
  busy.value = true;
  reviewMode.value = "save";
  actionError.value = "";
  try {
    review.value = await api(`/projects/${props.pid}/boards/${encodeURIComponent(props.boardKey)}/point-tables/forward/preview`, "POST", {
      revision: data.value.revision, operation: "recalculate", values: {},
    });
    if (!review.value?.allowed) emit("error", review.value?.errors.map((e: Row) => e.message).join("；") || "计算检查未通过");
  } catch (e) {
    actionError.value = (e as Error).message;
    emit("error", actionError.value);
    if (revisionConflict(e)) conflict();
  } finally { busy.value = false; }
}
function conflict() {
  review.value = null;
  editing.value = false;
  cancel();
  emit("conflict");
}
function saved(merged = false) {
  review.value = null;
  orderDraft.value = null;
  cancel();
  emit("done", merged);
}
function text(row: Row, key: string) {
  return grid.text(row, key);
}
</script>
<template>
  <div v-if="error" class="notice danger" role="alert">
    {{ error }} <button class="text-button" @click="reload++">重试</button>
  </div>
  <Loading v-else-if="!data || !def" />
  <template v-else>
    <div class="table-toolbar point-toolbar">
      <h2 class="point-table-title" :title="def.description">{{ def.label }}</h2>
      <span v-if="permissions.state.value?.edit_scope === 'scoped'" class="point-scope-label" :title="scopeEditable() ? '只可修改已获授权的板卡和协议；共享修改会在保存前检查全部影响范围。' : '未获本表编辑授权，可以查看和复制。'">{{ scopeEditable() ? '按范围授权' : '只读' }}</span>
      <div class="search">
        <Search :size="17" /><input
          v-model="query"
          :disabled="busy || !!review || !!orderDraft || !!grid.editor.value"
          aria-label="搜索当前表格"
          :placeholder="data && (isDspSheet(data) || isDspForward(data)) ? '搜索名称、变量、类型或分类…' : '搜索名称、sigID、地址或枚举…'"
        />
      </div>
      <div class="inline">
        <button v-if="def.calculation && canEditTable" class="button small" :disabled="dirty || busy || !!review" title="按当前配置计算整张表的字节数和偏移，预览后保存" @click="previewCalculation">重算协议布局</button>
        <button v-if="canEditTable" class="button small" :disabled="!grid.activeRow.value || !grid.active.value || !grid.editable(grid.activeRow.value, grid.active.value.column)" @click="grid.activeRow.value && grid.active.value && grid.start(grid.activeRow.value, grid.active.value.column)"><Pencil :size="14" />编辑单元格</button>
        <button class="icon-btn" aria-label="表格操作说明" title="表格操作说明" @click="showHelp = true"><CircleHelp :size="17" /></button>
        <button
          v-if="canEditTable"
          class="button primary small"
          @click="open(null)"
        >
          <Plus :size="16" />新建{{ def.label }}
        </button>
      </div>
    </div>
    <div v-if="classified" class="point-categories" role="group" aria-label="转发数据分类">
      <span>数据分类</span>
      <button class="button small" :class="{ primary: categoryFilter == null }" :aria-pressed="categoryFilter == null" :disabled="busy || !!review || !!orderDraft" @click="selectCategory(null)">全部分类 <small>{{ matched.length }}</small></button>
      <button v-for="category in categories" :key="category.key" class="button small" :class="{ primary: categoryFilter === category.key }" :aria-pressed="categoryFilter === category.key" :disabled="busy || !!review || !!orderDraft" @click="selectCategory(category.key)">{{ category.label }} <small>{{ category.count }}</small></button>
    </div>
    <div v-if="grid.changedRows.value || grid.hasHistory.value" class="point-grid-draft" role="status" aria-live="polite">
      <span class="point-draft-summary"><i />{{ grid.changedRows.value }} 行 · {{ grid.changedCells.value }} 处修改 <small>{{ draftWithinScope ? '尚未保存' : '缺少编辑授权 · 草稿保留' }}</small></span>
      <div class="inline">
        <button class="button small" :disabled="busy || !!review || !grid.undoStack.value.length" @click="grid.undo"><Undo2 :size="14" />撤销</button>
        <button class="button small" :disabled="busy || !!review || !grid.redoStack.value.length" @click="grid.redo"><Redo2 :size="14" />重做</button>
        <button class="button small" :disabled="busy || !!review" @click="discardGrid">放弃修改</button>
        <button class="button small" :disabled="!canEditTable || !draftWithinScope || busy || !!review || !grid.changedRows.value" title="检查当前修改及关联影响，保留草稿继续编辑" @click="previewGrid('check')"><Check :size="14" />{{ busy && reviewMode === 'check' ? '检查中…' : '检查' }}</button>
        <button class="button primary small" :disabled="!canEditTable || !draftWithinScope || busy || !!review || !grid.changedRows.value" @click="previewGrid('save')">{{ busy && reviewMode === 'save' ? '检查中…' : '检查并保存' }}</button>
      </div>
    </div>
    <div v-if="orderDraft" class="point-draft-bar" @keydown.esc="!busy && cancel()">
      <span>{{ !orderWithinScope ? '当前缺少排序所需的编辑授权，修改仍保留。' : def.ordering.mode === 'protocol' ? '协议布局已调整，提交前检查地址及共享协议影响。' : '显示顺序已调整，保存后项目成员共享此顺序。' }}</span>
      <button class="button small" :disabled="busy" @click="cancel">取消修改</button>
      <button class="button primary small" :disabled="!canEditTable || !orderWithinScope || busy || !dirty" @click="previewChange">检查关联影响</button>
    </div>
    <div v-if="actionError" class="notice danger" role="alert">{{ actionError }} <button class="text-button" @click="discard() && reload++">重新载入数据</button></div>
    <div v-if="moving" class="point-draft-bar">
      <label>组内目标位置 <input v-model.number="movePosition" type="number" min="1" :max="groupRows(moving).length" aria-label="组内目标位置" /></label>
      <button class="button small" @click="move(moving,movePosition)">移动</button><button class="text-button" @click="moving = null">关闭</button>
    </div>
    <div ref="gridTable" class="table-scroll sheet-scroll point-table point-grid" @copy="grid.copy" @paste="grid.paste">
      <table role="grid" :aria-label="def.label" :aria-rowcount="filtered.length + 1" :aria-colcount="displayColumns.length + 1" :aria-readonly="!canEditTable" aria-multiselectable="true">
        <thead ref="tableHead">
          <tr>
            <th class="row-number"><input type="checkbox" aria-label="选择当前页" title="选择当前页，最多 200 行" :checked="pageSelected" :indeterminate="pagePartSelected" :disabled="busy || !!review || !visible.length" @change="selectPage" /></th>
            <th v-for="column in displayColumns" :key="column.key" :data-column-key="column.key" tabindex="0"
              aria-haspopup="menu" :aria-expanded="tableMenu?.type === 'column' && tableMenu.key === column.key"
              :title="`${columnLabel(column.key)} · 右键设置列，或按 Shift+F10`"
              @contextmenu.prevent.stop="openColumnMenu(column.key, $event)" @keydown="columnKeydown(column.key, $event)"
              :class="{ 'point-frozen': column.frozen }" :style="column.frozen ? { left: `${frozenLeft[column.key] ?? 0}px` } : undefined">
              <span class="point-grid-column"><span class="point-field-type" aria-hidden="true">{{ !grid.field(column.key) ? 'ƒ' : def.fields[grid.field(column.key)!].reference ? '↗' : def.fields[grid.field(column.key)!].type === 'number' ? '#' : def.fields[grid.field(column.key)!].type === 'boolean' ? '☑' : 'Aa' }}</span><span class="point-column-label">{{ columnLabel(column.key) }}</span><button class="icon-btn point-column-menu" :aria-label="`${columnLabel(column.key)}列菜单`" aria-haspopup="menu" :aria-expanded="tableMenu?.type === 'column' && tableMenu.key === column.key" :disabled="busy || !!review" @click.stop="openColumnMenu(column.key, $event)"><ChevronDown :size="13" /></button></span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in visible" :key="row.id" :data-row-id="row.id" :aria-rowindex="(page - 1) * pageSize + i + 2" :class="{'point-drop-target':dropId === row.id}" @dragover="dragOver(row,$event)" @drop="drop(row,$event)">
            <td class="row-number point-row-order">
              <div class="point-row-tools">
              <button v-if="orderEnabled" class="icon-btn drag-handle" :draggable="canMove(row)" :disabled="!canMove(row)" :aria-label="`调整 ${row.name || row.signal_name} 的顺序`" title="拖动排序；点击指定位置；方向键上下移动" @dragstart="startDrag(row,$event)" @dragend="dragging = null; dropId = undefined" @click="choosePosition(row)" @keydown.up.prevent="move(row,groupRows(row).findIndex(r => r.id === row.id))" @keydown.down.prevent="move(row,groupRows(row).findIndex(r => r.id === row.id)+2)"><GripVertical :size="16" /></button>
              <button class="point-row-select" role="checkbox" :aria-checked="grid.isRowSelected(row.id)" :aria-label="`选择第 ${(page - 1) * pageSize + i + 1} 行`" title="选择此行；Shift 连续选择多行" :disabled="busy || !!review" @click="grid.selectRow(row, $event.shiftKey)"><Check v-if="grid.isRowSelected(row.id)" :size="15" /><span v-else>{{ (page - 1) * pageSize + i + 1 }}</span></button>
              <button class="icon-btn point-row-menu" :aria-label="`记录操作 ${row.name || row.signal_name}`" aria-haspopup="menu" :aria-expanded="tableMenu?.type === 'row' && tableMenu.row.id === row.id" title="记录详情与关联操作" :disabled="busy || !!review" @click="openRowMenu(row, $event)"><Ellipsis :size="15" /></button>
              </div>
            </td>
            <td v-for="(column, columnIndex) in displayColumns" :key="column.key" :data-column-key="column.key" role="gridcell"
              :aria-colindex="columnIndex + 2" :aria-selected="grid.selected(row.id, column.key)" :aria-readonly="!grid.editable(row, column.key)"
              :tabindex="grid.isActive(row.id, column.key) || (!grid.active.value && i === 0 && columnIndex === 0) ? 0 : -1"
              :title="cellHint(row, column.key)"
              :class="{ 'point-frozen': column.frozen, 'point-cell-active': grid.isActive(row.id, column.key), 'point-cell-selected': grid.selected(row.id, column.key), 'point-cell-modified': grid.modified(row, column.key), 'point-cell-editing': grid.isEditing(row.id, column.key), 'point-cell-readonly': !grid.field(column.key) }"
              :style="column.frozen ? { left: `${frozenLeft[column.key] ?? 0}px` } : undefined"
              @mousedown.prevent="grid.choose(row, column.key, $event.shiftKey)"
              @focus="!grid.isActive(row.id, column.key) && grid.choose(row, column.key)"
              @dblclick="grid.start(row, column.key)"
              @keydown.stop="grid.keydown($event, row, column.key)">
              <template v-if="grid.isEditing(row.id, column.key) && gridEditorDef">
                <select v-if="gridEditorDef.reference || gridEditorDef.options || gridEditorDef.type === 'boolean'"
                  v-model="gridInput" class="point-cell-editor" :aria-label="`编辑 ${gridEditorDef.label}`" :disabled="!canWrite || !scopeEditable(row)"
                  @mousedown.stop @click.stop @dblclick.stop @keydown.stop="grid.editorKey" @change="grid.finish() && grid.focusActive()" @blur="grid.finish">
                  <template v-if="gridEditorDef.type === 'boolean'"><option value="true">是</option><option value="false">否</option></template>
                  <template v-else-if="gridEditorDef.reference"><option value="">请选择</option><option v-for="choice in grid.choices.value" :key="choice.id" :value="String(choice.id)">{{ choiceLabel(choice) }}</option></template>
                  <template v-else><option v-if="gridEditorDef.nullable" value="">未指定</option><option v-for="option in gridEditorDef.options" :key="option" :value="option">{{ option }}</option></template>
                </select>
                <textarea v-else-if="gridEditorDef.multiline" v-model="gridInput" class="point-cell-editor" :aria-label="`编辑 ${gridEditorDef.label}`" :disabled="!canWrite || !scopeEditable(row)"
                  @mousedown.stop @click.stop @dblclick.stop @keydown.stop="grid.editorKey" @blur="grid.finish" />
                <input v-else v-model="gridInput" class="point-cell-editor" type="text" :inputmode="gridEditorDef.type === 'number' ? 'decimal' : undefined" :disabled="!canWrite || !scopeEditable(row)"
                  :aria-label="`编辑 ${gridEditorDef.label}`" :placeholder="gridEditorDef.nullable ? '留空表示未指定' : ''"
                  @mousedown.stop @click.stop @dblclick.stop @keydown.stop="grid.editorKey" @blur="grid.finish" />
              </template>
              <span
                v-else class="point-cell-value" :class="{ 'record-name': column.key === def.columns[0], 'point-cell-boolean': typeof row[column.key] === 'boolean', 'point-cell-multiline': def.fields[column.key].multiline }"

                >{{ text(row, column.key) }}</span
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="point-grid-status" :class="{ 'point-grid-selection-bar': !!selectionLabel }" role="status" aria-live="polite">
      <template v-if="selectionLabel">
        <strong>{{ selectionLabel }}</strong>
        <button class="button small" :disabled="busy || !!review" title="Ctrl/Cmd+C · 按当前可见列复制" @click="copyGrid()"><Copy :size="14" />{{ grid.selectedRowIds.value.length ? '复制选中行' : '复制选区' }}</button>
        <button class="text-button" :disabled="busy || !!review" @click="grid.finish() && grid.clearSelection()">取消选择</button>
      </template>
      <span v-if="copyFeedback" class="point-copy-feedback">{{ copyFeedback }}</span>
      <template v-else-if="grid.active.value && grid.activeRow.value"><strong>{{ def.fields[grid.active.value.column].column_label || def.fields[grid.active.value.column].label }}</strong><span>{{ cellHint(grid.activeRow.value, grid.active.value.column) }}</span></template>
      <span v-else-if="!selectionLabel">{{ scopeEditable() ? `选择一个单元格开始${canEditTable ? '编辑' : '查看'}。计算列随来源数据更新。` : '本表未获编辑授权，可以查看和复制。请联系管理员分配板卡和协议权限。' }}</span>
      <button v-if="classified && grid.activeRow.value && canEditTable && communicationDiffers(data, grid.values(grid.activeRow.value), grid.activeRow.value)" class="button small" :disabled="busy || !!review || !!orderDraft || !scopeEditable(grid.activeRow.value)" @click="grid.applyRecommendation(grid.activeRow.value)">应用通信建议</button>
    </div>
    <Empty
      v-if="!visible.length"
      title="当前表格暂无匹配记录"
      detail="调整筛选，或添加当前板卡需要的点表配置。"
    />
    <div class="pagination">
      <div class="inline pagination-summary">
        <span>共 {{ filtered.length }} 条</span>
        <label class="page-size-control">每页
          <select :value="pageSize" aria-label="每页条数" :disabled="busy || !!review" @change="changePageSize">
            <option v-for="size in pageSizeOptions" :key="size" :value="size">{{ size }}</option>
          </select>条
        </label>
      </div>
      <div class="inline">
        <button
          class="icon-btn"
          aria-label="上一页"
          :disabled="page <= 1 || busy || !!review"
          @click="grid.finish() && page--"
        >
          <ChevronLeft :size="18" /></button
        ><span>{{ page }} / {{ pages }}</span>
        <button
          class="icon-btn"
          aria-label="下一页"
          :disabled="page >= pages || busy || !!review"
          @click="grid.finish() && page++"
        >
          <ChevronRight :size="18" />
        </button>
      </div>
    </div>
    <Modal v-if="showHelp" title="表格操作说明" @close="showHelp = false">
      <div class="point-table-help">
        <p>{{ def.description }}</p>
        <ul>
          <li>点击“开始编辑”获得项目编辑权；提交成功后自动释放。</li>
          <li>双击单元格或按 Enter 编辑，按 Tab 切换；支持从 Excel 粘贴。</li>
          <li>“检查”只查看草稿的校验结果和关联影响，保留编辑权；“检查并保存”经确认后提交。</li>
          <li>点击行号选行，按住 Shift 连选；也可选择矩形区域后复制。</li>
          <li>右键列头设置列；点击行号旁的 ⋯ 查看记录详情和关联操作。</li>
          <li>只读状态也可以选择并复制数据，计算列会随来源数据更新。</li>
          <li>修改内部点后会检查关联转发的类型、长度与转换规则，未通过校验不会提交。</li>
        </ul>
      </div>
    </Modal>
    <ContextMenu v-if="tableMenu" :key="tableMenu.serial" :x="tableMenu.x" :y="tableMenu.y" :label="menuLabel" :items="menuItems" @select="menuAction" @close="tableMenu = null" />
    <PointChangePreview v-if="review" :pid="pid" :preview="review" :check-only="reviewMode === 'check'" :can-write="canEditTable && draftWithinScope && orderWithinScope" :fields="def.fields" :title="reviewMode === 'check' ? '草稿检查结果' : grid.changedRows.value ? '单元格变更预览' : orderDraft ? '排序变更预览' : '协议布局计算预览'" @close="review = null" @done="saved" @error="emit('error', $event)" @conflict="previewConflict" />
    <PointColumns v-if="columnSettings" :definition="def" :columns="columns" @close="columnSettings = false" @apply="applyColumns" />
    <PointEditor
      v-if="editing"
      :key="selected?.id || 'new'"
      :pid="pid"
      :board-key="boardKey"
      :data="scopedData!"
      :row="selected"
      :can-write="canWrite && scopeEditable(selected)"
      :group-key="groupKey"
      :endpoint-key="endpointKey"
      :process-point-id="processPointId"
      @dirty="editorDirty = $event"
      @error="emit('error', $event)"
      @conflict="conflict"
      @close="editing = false"
      @done="
        editing = false;
        emit('done', $event);
      "
    />
    <Modal v-if="forwardSignal" :title="`${forwardSignal.name} · 转发配置`" wide @close="closeForward">
      <div class="modal-body point-forwarding">
        <p class="notice">此处与转发表共用配置，同一个内部点可以配置多条转发映射。</p>
        <PointTable :pid="pid" :board-key="boardKey" kind="forward" :label="forwardLabel || '转发点表'"
          :revision="revision" :can-write="canWrite"
          :group-key="forwardSignal.group_key" :process-point-id="forwardSignal.id"
          @done="emit('done', $event)" @conflict="forwardSignal = null; conflict()"
          @error="emit('error', $event)" @dirty="forwardDirty = $event" />
      </div>
      <div class="modal-footer"><button class="button" @click="closeForward">关闭转发配置</button></div>
    </Modal>
  </template>
</template>
