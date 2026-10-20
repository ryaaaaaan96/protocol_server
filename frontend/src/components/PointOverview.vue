<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { api, type Row } from "../api";
import { fieldForColumn, parseCell } from "../domain/pointGrid";
import { communicationHint, type PointTableData } from "../domain/pointTables";
import { columnSource, initialValues, overviewDefinition, overviewEntries, overviewRows, overviewText, overviewValues, sourceKey,
  type OverviewKind as PointKind, type OverviewData, type OverviewDraft, type OverviewRow } from "../domain/pointOverview";
import { orderedColumns, restoreColumns, type TableColumn } from "../domain/tableColumns";
import { allowsPoint } from "../domain/permissions";
import { usePermissionContext } from "../composables/useProjectPermissions";
import { pageSizeOptions, usePageSize } from "../composables/usePageSize";
import Loading from "./Loading.vue";
import Empty from "./Empty.vue";
import PointColumns from "./PointColumns.vue";
import PointChangePreview from "./PointChangePreview.vue";
import PointEditor from "./PointEditor.vue";
import PointValueInput from "./PointValueInput.vue";

const props = defineProps<{ pid: number; boardKey: string; revision: number; canWrite: boolean; groupKey?: string }>();
const emit = defineEmits<{ done: [merged?: boolean]; error: [message: string]; dirty: [value: boolean] }>();
const data = ref<OverviewData | null>(null), error = ref(""), actionError = ref(""), reload = ref(0);
const draft = ref<OverviewDraft>({}), undo = ref<OverviewDraft[]>([]), redo = ref<OverviewDraft[]>([]);
const busy = ref(false), review = ref<Row | null>(null), checkOnly = ref(false);
const query = ref(""), mappingFilter = ref("all"), page = ref(1);
const columns = ref<TableColumn[]>([]), columnSettings = ref(false);
const permissions = usePermissionContext();
const root = ref<HTMLElement>(), head = ref<HTMLElement>(), frozenLeft = ref<Record<string, number>>({});
type Cell = { row: OverviewRow; key: string; value: unknown; original: unknown };
const active = ref<{ row: string; key: string } | null>(null), editor = ref<Cell | null>(null);
const detail = ref<{ kind: PointKind; row: Row | null; processId?: number } | null>(null), detailDirty = ref(false);
const changed = computed(() => Object.keys(draft.value).length);
const dirty = computed(() => !!changed.value || detailDirty.value || !!editor.value && !Object.is(editor.value.value, editor.value.original));
watch(dirty, value => emit("dirty", value), { flush: "sync" });
onBeforeUnmount(() => emit("dirty", false));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
watch(() => [props.pid, props.boardKey, props.revision, reload.value], async (_, __, cleanup) => {
  let cancelled = false;
  cleanup(() => { cancelled = true; });
  data.value = null; error.value = ""; review.value = null; detail.value = null;
  draft.value = {}; undo.value = []; redo.value = []; editor.value = null; active.value = null;
  try {
    const result = await api(`/projects/${props.pid}/boards/${encodeURIComponent(props.boardKey)}/point-tables/overview`);
    if (!cancelled) data.value = result;
  } catch (cause) { if (!cancelled) error.value = (cause as Error).message; }
}, { immediate: true });
const def = computed(() => data.value ? overviewDefinition(data.value) : null);
const columnKey = computed(() => `point-columns:${props.pid}:${encodeURIComponent(props.boardKey)}:overview:${JSON.stringify(def.value?.columns)}`);
watch([def, columnKey], () => {
  if (!def.value) return;
  let saved: unknown;
  try { saved = JSON.parse(localStorage.getItem(columnKey.value) || "null"); } catch {}
  columns.value = restoreColumns(def.value.columns, saved);
}, { immediate: true });
const visibleColumns = computed(() => orderedColumns(columns.value).filter(column => column.visible));
const { pageSize, setPageSize } = usePageSize(computed(() => `point-page-size:${props.pid}:${props.boardKey}:overview`));
const joined = computed(() => data.value ? overviewRows(data.value, props.groupKey) : []);
const filtered = computed(() => joined.value.filter(row =>
  (mappingFilter.value === "all" || (mappingFilter.value === "missing") === !row.forward) &&
  (!query.value.trim() || def.value!.columns.some(key => text(row, key).toLowerCase().includes(query.value.trim().toLowerCase())))));
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize.value)));
const visible = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
watch([query, mappingFilter], () => { page.value = 1; });
watch(pages, value => { page.value = Math.min(page.value, value); });
function text(row: OverviewRow, key: string) { return overviewText(data.value!, draft.value, row, key); }
function values(kind: PointKind, row: Row) { return overviewValues(data.value!, draft.value, kind, row); }
function allowed(kind: PointKind, row?: Row | null) {
  return !!data.value && props.canWrite && allowsPoint(permissions.state.value, props.boardKey, kind, data.value[kind], row);
}
function field(key: string) {
  const { kind, column } = columnSource(key);
  return data.value && fieldForColumn(data.value[kind], column);
}
function editable(row: OverviewRow, key: string) {
  const { kind } = columnSource(key), source = row[kind];
  return !!source && !!field(key) && allowed(kind, source) && !busy.value && !review.value;
}
function modified(row: OverviewRow, key: string) {
  const { kind } = columnSource(key), source = row[kind], name = field(key);
  return !!source && !!name && Object.hasOwn(draft.value[sourceKey(kind, source.id)] || {}, name);
}
function hint(row: OverviewRow, key: string) {
  const { kind } = columnSource(key), source = row[kind];
  if (!source) return "此内部点尚未配置转发，可通过末列“添加转发”配置。";
  if (!field(key)) return "关联或计算字段，随来源数据更新。";
  if (!allowed(kind, source)) return "当前为只读，或未获此记录的编辑权限。";
  if (kind === "forward" && ["forward:effective_type", "forward:scale"].includes(key))
    return communicationHint(data.value!.forward, values(kind, source), source);
  return kind === "process" ? "双击或按 Enter 编辑；同一内部点的所有关联行共享此值。" : "双击或按 Enter 编辑此转发映射。";
}
function saveDraft(next: OverviewDraft) {
  if (JSON.stringify(next) === JSON.stringify(draft.value)) return;
  undo.value.push(clone(draft.value)); redo.value = []; draft.value = next;
}
function finish() {
  const cell = editor.value;
  if (!cell) return true;
  const { kind } = columnSource(cell.key), source = cell.row[kind]!, key = field(cell.key)!;
  if (!Object.is(cell.value, cell.original) && !editable(cell.row, cell.key)) {
    actionError.value = "当前无法编辑，输入已保留；请重新取得编辑权。";
    return false;
  }
  try {
    if (!Object.is(cell.value, cell.original)) {
      const parsed = parseCell(data.value![kind], key, cell.value == null ? null : String(cell.value), values(kind, source));
      if (["name", "variable_name"].includes(key) && !String(parsed ?? "").trim()) throw new Error("名称不能为空。");
      const next = clone(draft.value), id = sourceKey(kind, source.id);
      next[id] = { ...next[id], [key]: parsed };
      if (Object.is(parsed, initialValues(data.value![kind], source)[key])) delete next[id][key];
      if (!Object.keys(next[id]).length) delete next[id];
      saveDraft(next);
    }
    editor.value = null; actionError.value = "";
    return true;
  } catch (cause) { actionError.value = (cause as Error).message; return false; }
}
async function focusActive() {
  await nextTick();
  const cell = [...(root.value?.querySelectorAll<HTMLElement>("td[data-column-key]") || [])]
    .find(cell => cell.dataset.columnKey === active.value?.key && cell.parentElement?.dataset.rowKey === active.value?.row);
  (cell?.querySelector<HTMLElement>("input,select,textarea") || cell)?.focus();
}
function focusout(event: FocusEvent) {
  if (!(event.relatedTarget instanceof Node && (event.currentTarget as HTMLElement).contains(event.relatedTarget))) finish();
}
function choose(row: OverviewRow, key: string) {
  if (busy.value || review.value || !finish()) return;
  active.value = { row: row.key, key };
}
async function start(row: OverviewRow, key: string) {
  if (!finish() || !editable(row, key)) return;
  const { kind } = columnSource(key), value = values(kind, row[kind]!)[field(key)!];
  active.value = { row: row.key, key };
  editor.value = { row, key, value, original: value };
  await focusActive();
}
function keydown(event: KeyboardEvent, row: OverviewRow, key: string) {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Escape" && editor.value) {
    event.preventDefault(); editor.value = null; actionError.value = ""; void focusActive(); return;
  }
  if (event.key === "Enter" && event.shiftKey && event.target instanceof HTMLTextAreaElement) return;
  if (event.key === "Enter" && !editor.value) { event.preventDefault(); void start(row, key); return; }
  if (!["Tab", "Enter"].includes(event.key)) return;
  event.preventDefault();
  if (!finish()) return;
  const width = visibleColumns.value.length, index = filtered.value.findIndex(item => item.key === row.key);
  const column = visibleColumns.value.findIndex(item => item.key === key);
  const position = index * width + column + (event.shiftKey ? -1 : 1) * (event.key === "Enter" ? width : 1);
  if (position < 0 || position >= filtered.value.length * width) { void focusActive(); return; }
  const next = filtered.value[Math.floor(position / width)], nextKey = visibleColumns.value[position % width].key;
  active.value = { row: next.key, key: nextKey };
  page.value = Math.floor(Math.floor(position / width) / pageSize.value) + 1;
  void focusActive();
}
const editorData = computed<PointTableData | null>(() => {
  if (!data.value || !editor.value) return null;
  return data.value[columnSource(editor.value.key).kind];
});
const editorValues = computed(() => {
  if (!editor.value) return {};
  const { kind } = columnSource(editor.value.key);
  return { ...values(kind, editor.value.row[kind]!), [field(editor.value.key)!]: editor.value.value };
});
function discard() {
  if (dirty.value && !window.confirm("放弃总体视图中尚未保存的修改？")) return false;
  draft.value = {}; editor.value = null; undo.value = []; redo.value = []; actionError.value = "";
  return true;
}
function history(direction: "undo" | "redo") {
  if (!finish() || busy.value || review.value) return;
  const from = direction === "undo" ? undo : redo, to = direction === "undo" ? redo : undo;
  if (!from.value.length) return;
  to.value.push(clone(draft.value)); draft.value = from.value.pop()!;
}
const draftAllowed = computed(() => !!data.value && overviewEntries(data.value, draft.value).every(entry => {
  const row = data.value![entry.kind].rows.find(row => row.id === entry.id)!;
  return allowed(entry.kind, row) && allowed(entry.kind, { ...row, edit_values: values(entry.kind, row) });
}));
async function preview(check: boolean) {
  if (!finish() || !changed.value || !draftAllowed.value || busy.value || review.value) return;
  checkOnly.value = check; busy.value = true; actionError.value = "";
  try {
    review.value = await api(`/projects/${props.pid}/boards/${encodeURIComponent(props.boardKey)}/point-tables/overview/batch/preview`, "POST", {
      revision: data.value!.revision, operation: "update", rows: overviewEntries(data.value!, draft.value),
    });
    if (!review.value!.allowed) emit("error", review.value!.errors.map((item: Row) => item.message).join("；"));
  } catch (cause) {
    actionError.value = (cause as Error).message;
    emit("error", actionError.value);
  } finally { busy.value = false; }
}
function conflict() {
  review.value = null;
  actionError.value = "相同字段、关联数据或计算脚本已变化，本次修改未保存。草稿已保留，请核对后重新检查，或重新载入数据。";
}
function saved(merged = false) {
  draft.value = {}; editor.value = null; detail.value = null; detailDirty.value = false;
  review.value = null; undo.value = []; redo.value = []; reload.value++;
  emit("done", merged);
}
function openDetail(kind: PointKind, row: OverviewRow) {
  if (!finish() || busy.value || review.value) return;
  if (changed.value) {
    actionError.value = "请先保存或放弃单元格草稿，再打开记录设置。";
    return;
  }
  detail.value = { kind, row: row[kind] || null, processId: kind === "forward" ? row.process.id : undefined };
}
function applyColumns(settings: TableColumn[]) {
  if (!finish()) return;
  columns.value = restoreColumns(def.value!.columns, settings); columnSettings.value = false;
  try { localStorage.setItem(columnKey.value, JSON.stringify(columns.value)); }
  catch { emit("error", "列设置已应用，但浏览器未能保存。"); }
}
function measure() {
  let left = head.value?.querySelector(".row-number")?.getBoundingClientRect().width || 0;
  const offsets: Record<string, number> = {};
  for (const column of visibleColumns.value.filter(column => column.frozen)) {
    offsets[column.key] = left;
    left += [...(head.value?.querySelectorAll<HTMLElement>("[data-column-key]") || [])]
      .find(cell => cell.dataset.columnKey === column.key)?.getBoundingClientRect().width || 0;
  }
  frozenLeft.value = offsets;
}
watch([head, visibleColumns], async (_, __, cleanup) => {
  let cancelled = false, observer: ResizeObserver | undefined;
  cleanup(() => { cancelled = true; observer?.disconnect(); });
  await nextTick();
  if (cancelled || !head.value) return;
  observer = new ResizeObserver(measure);
  for (const cell of head.value.querySelectorAll("th")) observer.observe(cell);
  measure();
}, { flush: "post" });
</script>

<template>
  <div v-if="error" class="notice danger" role="alert">{{ error }} <button class="text-button" @click="reload++">重试</button></div>
  <Loading v-else-if="!data || !def" />
  <template v-else>
    <div class="sheet-heading overview-heading">
      <strong>总体视图</strong><span>内部数据与转发参数并列；重复的内部点共享修改。</span>
      <button class="button small" :disabled="busy || !!review" @click="finish() && (columnSettings = true)">列设置</button>
    </div>
    <div class="overview-toolbar">
      <input :value="query" aria-label="搜索总体视图" placeholder="搜索内部数据或转发参数…" :disabled="!!editor || busy || !!review" @input="query = ($event.target as HTMLInputElement).value" />
      <select v-model="mappingFilter" aria-label="转发配置筛选" :disabled="!!editor || busy || !!review">
        <option value="all">全部数据</option><option value="linked">已配置转发</option><option value="missing">未配置转发</option>
      </select>
      <span>{{ new Set(joined.map(row => row.process.id)).size }} 个内部点 · {{ joined.filter(row => row.forward).length }} 条转发</span>
    </div>
    <div v-if="dirty || undo.length || redo.length" class="point-draft-bar">
      <span>已修改 {{ changed }} 条源记录；预览通过后统一保存。</span>
      <button class="button small" :disabled="!undo.length || busy || !!review" @click="history('undo')">撤销</button>
      <button class="button small" :disabled="!redo.length || busy || !!review" @click="history('redo')">重做</button>
      <button class="button small" :disabled="busy || !!review" @click="discard">放弃修改</button>
      <button class="button small" :disabled="!dirty || !draftAllowed || busy || !!review" @click="preview(true)">检查</button>
      <button class="button primary small" :disabled="!dirty || !draftAllowed || busy || !!review" @click="preview(false)">检查并保存</button>
    </div>
    <div v-if="actionError" class="notice danger" role="alert">{{ actionError }} <button class="text-button" @click="discard() && reload++">重新载入数据</button></div>
    <div ref="root" class="table-scroll sheet-scroll point-table point-grid point-overview">
      <table role="grid" aria-label="DSP 总体视图" :aria-readonly="!canWrite" :aria-rowcount="filtered.length + 1">
        <thead ref="head"><tr>
          <th class="row-number">行</th>
          <th v-for="column in visibleColumns" :key="column.key" :data-column-key="column.key"
            :class="['overview-column', columnSource(column.key).kind, { 'point-frozen': column.frozen }]"
            :style="column.frozen ? { left: `${frozenLeft[column.key] || 0}px` } : undefined">
            <small>{{ columnSource(column.key).kind === 'process' ? data.process.definition.label : data.forward.definition.label }}</small>
            <span class="point-column-label">{{ def.fields[column.key].column_label || def.fields[column.key].label }}</span>
          </th>
          <th class="overview-actions">操作 · 固定</th>
        </tr></thead>
        <tbody><tr v-for="(row, index) in visible" :key="row.key" :data-row-key="row.key">
          <td class="row-number">{{ (page - 1) * pageSize + index + 1 }}</td>
          <td v-for="column in visibleColumns" :key="column.key" :data-column-key="column.key" role="gridcell"
            :tabindex="active?.row === row.key && active.key === column.key || !active && index === 0 && column.key === visibleColumns[0]?.key ? 0 : -1"
            :aria-readonly="!editable(row, column.key)" :title="hint(row, column.key)"
            :class="{ 'point-frozen': column.frozen, 'point-cell-modified': modified(row, column.key), 'point-cell-readonly': !field(column.key) || !row[columnSource(column.key).kind],
              'point-cell-active': active?.row === row.key && active.key === column.key, 'point-cell-editing': editor?.row.key === row.key && editor.key === column.key }"
            :style="column.frozen ? { left: `${frozenLeft[column.key] || 0}px` } : undefined"
            @click="!editor && choose(row, column.key)" @dblclick="start(row, column.key)" @keydown="keydown($event, row, column.key)">
            <div v-if="editor?.row.key === row.key && editor.key === column.key && editorData" @click.stop @dblclick.stop
              @focusout="focusout">
              <PointValueInput :data="editorData" :field-key="field(column.key)!" :values="editorValues" :disabled="!editable(row, column.key)" autofocus @change="editor && (editor.value = $event)" />
            </div>
            <span v-else class="point-cell-value" :class="{ 'point-cell-multiline': def.fields[column.key].multiline }">{{ text(row, column.key) }}</span>
          </td>
          <td class="overview-actions">
            <button class="text-button" :disabled="busy || !!review" @click="openDetail('process', row)">内部设置</button>
            <button v-if="row.forward || allowed('forward')" class="text-button" :disabled="busy || !!review" @click="openDetail('forward', row)">{{ row.forward ? '转发设置' : '添加转发' }}</button>
            <span v-else class="muted">未配置转发</span>
          </td>
        </tr></tbody>
      </table>
    </div>
    <Empty v-if="!visible.length" title="没有匹配的记录" detail="请调整搜索或转发筛选条件。" />
    <div class="pagination">
      <div class="inline"><span>共 {{ filtered.length }} 行</span>
        <label class="page-size-control">每页 <select :value="pageSize" aria-label="每页条数" :disabled="!!editor || busy || !!review" @change="setPageSize(Number(($event.target as HTMLSelectElement).value)); page = 1"><option v-for="size in pageSizeOptions" :key="size" :value="size">{{ size }}</option></select> 条</label>
      </div>
      <div class="inline">
        <button class="button small" :disabled="page <= 1 || !!editor || busy || !!review" @click="page--">上一页</button>
        <span>{{ page }} / {{ pages }}</span>
        <button class="button small" :disabled="page >= pages || !!editor || busy || !!review" @click="page++">下一页</button>
      </div>
    </div>
    <PointColumns v-if="columnSettings" :definition="def" :columns="columns" @close="columnSettings = false" @apply="applyColumns" />
    <PointChangePreview v-if="review" :pid="pid" :preview="review" :check-only="checkOnly" :can-write="canWrite && draftAllowed"
      :fields="{ ...data.forward.definition.fields, ...data.process.definition.fields }"
      :fields-by-entity="{ process_points: data.process.definition.fields, transmit_points: data.forward.definition.fields }"
      :title="checkOnly ? '总体视图检查结果' : '总体视图变更预览'" @close="review = null" @done="saved" @error="emit('error', $event)" @conflict="conflict" />
    <PointEditor v-if="detail" :pid="pid" :board-key="boardKey" :data="data[detail.kind]" :row="detail.row"
      :process-point-id="detail.processId" :can-write="allowed(detail.kind, detail.row)" :group-key="groupKey"
      @close="detail = null" @dirty="detailDirty = $event" @done="saved" @error="emit('error', $event)" @conflict="conflict" />
  </template>
</template>
