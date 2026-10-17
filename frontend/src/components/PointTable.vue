<script setup lang="ts">
import { computed, ref, watch, nextTick, onBeforeUnmount } from "vue";
import { api, revisionConflict, type Row } from "../api";
import {
  pointText,
  type PointKind,
  type PointTableData,
} from "../domain/pointTables";
import { Search, Plus, ChevronLeft, ChevronRight, GripVertical, Pin } from "@lucide/vue";
import Loading from "./Loading.vue";
import Empty from "./Empty.vue";
import PointEditor from "./PointEditor.vue";
import PointColumns from "./PointColumns.vue";
import { restoreColumns, orderedColumns, type TableColumn } from "../domain/tableColumns";
import PointChangePreview from "./PointChangePreview.vue";
import Modal from "./Modal.vue";
const props = defineProps<{
  pid: number;
  modelId: number;
  kind: PointKind;
  label: string;
  revision: number;
  canWrite: boolean;
  processEnabled: boolean;
  focusId?: number;
  groupId?: number;
  signalId?: number;
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
const filter = ref<number | "">("");
const editing = ref(false),
  selected = ref<Row | null>(null);
const reload = ref(0);
const editorDirty = ref(false), forwardDirty = ref(false), forwardSignal = ref<Row | null>(null);
const orderDraft = ref<{key: string; ids: number[]; original: Row[]} | null>(null);
const moving = ref<Row | null>(null), movePosition = ref(1), dragging = ref<Row | null>(null);
const dropId = ref<number>(), review = ref<Row | null>(null), busy = ref(false), actionError = ref("");
const dirty = computed(() => !!orderDraft.value || editorDirty.value || forwardDirty.value);
watch(dirty, value => emit("dirty", value), {flush:"sync"});
onBeforeUnmount(() => emit("dirty", false));
watch(
  () => [
    props.pid, props.modelId, props.kind, props.label, props.revision, reload.value,
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
        `/projects/${props.pid}/board-models/${props.modelId}/point-tables/${props.kind}`,
      );
      if (!cancelled) {
        result.definition.label = props.label;
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
const columnSettings = ref(false), columns = ref<TableColumn[]>([]);
const columnKey = computed(() => `point-columns:${props.pid}:${props.modelId}:${props.kind}`);
const displayColumns = computed(() => orderedColumns(columns.value).filter(c => c.visible));
watch([() => def.value?.columns, columnKey], ([keys]) => {
  if (!keys) return;
  let saved: unknown;
  try { saved = JSON.parse(localStorage.getItem(columnKey.value) || "null"); } catch {}
  columns.value = restoreColumns(keys, saved);
}, { immediate: true });
function applyColumns(settings: TableColumn[]) {
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
  if (props.groupId != null) {
    options.groups = options.groups.filter(g => g.id === props.groupId);
    options.contexts = options.contexts.filter(c => c.group_id === props.groupId);
    options.signals = options.signals.filter(s => s.group_id === props.groupId);
  }
  if (props.signalId != null) options.signals = options.signals.filter(s => s.id === props.signalId);
  return { ...data.value, options };
});
const contextOptions = computed(() => scopedData.value?.options.contexts.filter(c => c.group_id != null) || []);
watch(contextOptions, options => {
  if (!data.value) return;
  if (filter.value !== "" && !options.some(c => c.id === filter.value)) filter.value = "";
});
function inScope(row: Row) {
  return (props.signalId == null || row.signal_id === props.signalId) &&
    (props.groupId == null || (props.kind === "process" ? row.group_id === props.groupId :
      data.value?.options.signals.some(s => s.id === row.signal_id && s.group_id === props.groupId)));
}
const indexed = computed(() =>
  (data.value?.rows || []).map((row) => ({
    row,
    search: def
      .value!.columns.map((key) => pointText(row[key]))
      .join(" ")
      .toLowerCase(),
  })),
);
const filtered = computed(() =>
  indexed.value
    .filter(
      ({ row, search }) =>
        inScope(row) &&
        (!filter.value || row.context_id === filter.value) &&
        search.includes(query.value.trim().toLowerCase()),
    )
    .map(({ row }) => row),
);
const pages = computed(() =>
  Math.max(1, Math.ceil(filtered.value.length / 50)),
);
const visible = computed(() =>
  filtered.value.slice((page.value - 1) * 50, page.value * 50),
);
watch([query, filter], () => {
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
}
const orderEnabled = computed(() => props.canWrite && def.value?.ordering.mode !== "disabled");
const canReorder = computed(() => orderEnabled.value && !query.value.trim() && !busy.value);
function groupKey(row:Row) { return JSON.stringify(def.value!.ordering.group_by.map(key => row[key] ?? 0)); }
function groupRows(row:Row) { return data.value!.rows.filter(r => groupKey(r) === groupKey(row)); }
const filteredIds = computed(() => new Set(filtered.value.map(r => r.id)));
function canMove(row:Row) {
  const members = groupRows(row);
  return canReorder.value && (!orderDraft.value || orderDraft.value.key === groupKey(row)) &&
    members.length > 1 && members.every(r => filteredIds.value.has(r.id));
}
function move(row:Row, position:number) {
  if (!canMove(row) || !Number.isInteger(position)) return;
  const group = groupRows(row), from = group.findIndex(r => r.id === row.id);
  if (position < 1 || position > group.length || from === position-1) return;
  const original = orderDraft.value?.original || [...data.value!.rows];
  const [item] = group.splice(from,1);
  group.splice(position-1,0,item);
  let index = 0;
  data.value!.rows = data.value!.rows.map(r => groupKey(r) === groupKey(row) ? group[index++] : r);
  const same = original.every((r,i) => r.id === data.value!.rows[i].id);
  orderDraft.value = same ? null : {key:groupKey(row),ids:group.map(r => r.id),original};
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
  if (dragging.value && canMove(row) && groupKey(row) === groupKey(dragging.value)) {
    event.preventDefault(); dropId.value = row.id;
  }
}
function drop(row:Row, event:DragEvent) {
  event.preventDefault();
  if (dragging.value && groupKey(row) === groupKey(dragging.value)) move(dragging.value,groupRows(row).findIndex(r => r.id === row.id)+1);
  dragging.value = null; dropId.value = undefined;
}
function choosePosition(row:Row) {
  moving.value = row;
  movePosition.value = groupRows(row).findIndex(r => r.id === row.id)+1;
}
async function previewChange() {
  if (!data.value || !orderDraft.value || busy.value || review.value) return;
  busy.value = true;
  actionError.value = "";
  try {
    const base = `/projects/${props.pid}/board-models/${props.modelId}/point-tables/${props.kind}`;
    review.value = await api(`${base}/reorder/preview`, "POST", {
      revision: data.value.revision,
      ids: orderDraft.value.ids,
      expected: orderDraft.value.original.filter(r => groupKey(r) === orderDraft.value!.key).map(r => r.id),
    });
    if (review.value && !review.value.allowed) emit("error", review.value.errors.map((e:Row) => e.message).join("；") || "关联检查未通过");
  } catch(e) {
    actionError.value = (e as Error).message;
    emit("error", actionError.value);
    if (revisionConflict(e)) conflict();
  }
  finally { busy.value = false; }
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
  if (key === "upp_model" && row.protocol !== "UPP") return "—";
  return pointText(row[key]);
}
</script>
<template>
  <div v-if="error" class="notice danger" role="alert">
    {{ error }} <button class="text-button" @click="reload++">重试</button>
  </div>
  <Loading v-else-if="!data || !def" />
  <template v-else>
    <div class="sheet-heading">
      <h2>{{ def.label }}</h2>
      <span>{{ def.description }}</span>
    </div>
    <div class="table-toolbar">
      <div class="search">
        <Search :size="17" /><input
          v-model="query"
          :disabled="busy || !!review || !!orderDraft"
          aria-label="搜索当前表格"
          placeholder="搜索名称、sigID、地址或枚举…"
        />
      </div>
      <select
        v-if="kind !== 'process' && contextOptions.length > 1"
        v-model="filter"
        :disabled="busy || !!review || !!orderDraft"
        class="point-filter"
        aria-label="筛选逻辑设备"
      >
        <option value="">
          全部逻辑设备
        </option>
        <option
          v-for="o in contextOptions"
          :key="o.id"
          :value="o.id"
        >
          {{ o.name }} [{{ o.dev_id }}]
        </option>
      </select>
      <div class="inline">
        <button class="button small" :disabled="busy || !!review" @click="columnSettings = true">列设置</button>
        <span class="muted">{{ filtered.length }} 条</span
        ><button
          v-if="canWrite"
          class="button primary small"
          @click="open(null)"
        >
          <Plus :size="16" />新建{{ def.label }}
        </button>
      </div>
    </div>
    <div v-if="orderDraft" class="point-draft-bar" @keydown.esc="!busy && cancel()">
      <span>{{ def.ordering.mode === 'protocol' ? '协议布局已调整，提交前检查地址及共享协议影响。' : '显示顺序已调整，保存后项目成员共享此顺序。' }}</span>
      <button class="button small" :disabled="busy" @click="cancel">取消修改</button>
      <button class="button primary small" :disabled="busy || !dirty" @click="previewChange">检查关联影响</button>
    </div>
    <div v-if="actionError" class="notice danger" role="alert">{{ actionError }} <button class="text-button" @click="discard() && reload++">重新载入数据</button></div>
    <div v-if="moving" class="point-draft-bar">
      <label>组内目标位置 <input v-model.number="movePosition" type="number" min="1" :max="groupRows(moving).length" aria-label="组内目标位置" /></label>
      <button class="button small" @click="move(moving,movePosition)">移动</button><button class="text-button" @click="moving = null">关闭</button>
    </div>
    <p v-if="orderEnabled" class="point-order-hint">拖动第一列手柄调整同组顺序；点击手柄可跨页移动，聚焦后用方向键上下移动。搜索或筛选隐藏了排序组内记录时，需清除筛选或选择全部分组。</p>
    <div class="table-scroll sheet-scroll point-table">
      <table :aria-label="def.label">
        <thead ref="tableHead">
          <tr>
            <th class="row-number">#</th>
            <th v-for="column in displayColumns" :key="column.key" :data-column-key="column.key"
              :class="{ 'point-frozen': column.frozen }" :style="column.frozen ? { left: `${frozenLeft[column.key] ?? 0}px` } : undefined">
              {{ def.fields[column.key].column_label || def.fields[column.key].label }}
            </th>
            <th class="point-actions">
              <span class="point-actions-title">操作 <span class="point-fixed-label" title="固定在右侧，横向滚动时保持可见"><Pin :size="12" aria-hidden="true" />固定</span></span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in visible" :key="row.id" :data-row-id="row.id" :class="{'point-drop-target':dropId === row.id}" @dragover="dragOver(row,$event)" @drop="drop(row,$event)" @keydown.esc="!busy && cancel()">
            <td class="row-number point-row-order">
              <button v-if="orderEnabled" class="icon-btn drag-handle" :draggable="canMove(row)" :disabled="!canMove(row)" :aria-label="`调整 ${row.name || row.signal_name} 的顺序`" title="拖动排序；点击指定位置；方向键上下移动" @dragstart="startDrag(row,$event)" @dragend="dragging = null; dropId = undefined" @click="choosePosition(row)" @keydown.up.prevent="move(row,groupRows(row).findIndex(r => r.id === row.id))" @keydown.down.prevent="move(row,groupRows(row).findIndex(r => r.id === row.id)+2)"><GripVertical :size="16" /></button>
              {{ (page - 1) * 50 + i + 1 }}
            </td>
            <td v-for="column in displayColumns" :key="column.key" :data-column-key="column.key"
              :class="{ 'point-frozen': column.frozen }" :style="column.frozen ? { left: `${frozenLeft[column.key] ?? 0}px` } : undefined">
              <span
                :class="{ 'record-name': column.key === def.columns[0] }"
                :title="
                  kind === 'process' &&
                  ['default_value', 'min_value', 'max_value'].includes(column.key)
                    ? row.edit_values[column.key] == null
                      ? '继承数据定义'
                      : '处理点覆盖值'
                    : undefined
                "
                >{{ text(row, column.key) }}</span
              >
            </td>
            <td class="point-actions">
              <div class="point-action-buttons">
                <button class="text-button" :disabled="busy || !!review" @click="open(row)">{{ canWrite ? '设置' : '查看' }}</button>
                <button v-if="kind === 'process' && allowForward" class="text-button" :disabled="busy || !!review" @click="openForward(row)">转发配置</button>
                <button
                  v-if="kind !== 'process' && signalId == null"
                  class="text-button"
                  :disabled="busy || !!review"
                  @click="discard() && emit('process', row.signal_id)"
                >
                  关联处理点</button
                >
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <Empty
      v-if="!visible.length"
      title="当前表格暂无匹配记录"
      detail="调整筛选，或添加当前板卡需要的点表配置。"
    />
    <div class="pagination">
      <span>共 {{ filtered.length }} 条 · 每页 50 条</span>
      <div class="inline">
        <button
          class="icon-btn"
          aria-label="上一页"
          :disabled="page <= 1 || busy || !!review"
          @click="page--"
        >
          <ChevronLeft :size="18" /></button
        ><span>{{ page }} / {{ pages }}</span>
        <button
          class="icon-btn"
          aria-label="下一页"
          :disabled="page >= pages || busy || !!review"
          @click="page++"
        >
          <ChevronRight :size="18" />
        </button>
      </div>
    </div>
    <PointChangePreview v-if="review" :pid="pid" :preview="review" title="排序变更预览" @close="review = null" @done="saved" @error="emit('error', $event)" @conflict="conflict" />
    <PointColumns v-if="columnSettings" :definition="def" :columns="columns" @close="columnSettings = false" @apply="applyColumns" />
    <PointEditor
      v-if="editing"
      :key="selected?.id || 'new'"
      :pid="pid"
      :model-id="modelId"
      :data="scopedData!"
      :row="selected"
      :can-write="canWrite"
      :process-enabled="processEnabled"
      :group-id="groupId"
      :signal-id="signalId"
      :context-id="kind !== 'process' && filter !== '' ? filter : undefined"
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
        <p class="notice">此处与转发点表共用配置。可为不同来源设备添加多条映射；AIDC 板卡的 VIR 服务随对外接口生成。</p>
        <PointTable :pid="pid" :model-id="modelId" kind="forward" :label="forwardLabel || '转发点表'"
          :revision="revision" :can-write="canWrite" :process-enabled="processEnabled"
          :group-id="forwardSignal.group_id" :signal-id="forwardSignal.id"
          @done="emit('done', $event)" @conflict="forwardSignal = null; conflict()"
          @error="emit('error', $event)" @dirty="forwardDirty = $event" />
      </div>
      <div class="modal-footer"><button class="button" @click="closeForward">关闭转发配置</button></div>
    </Modal>
  </template>
</template>
