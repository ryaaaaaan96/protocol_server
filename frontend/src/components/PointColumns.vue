<script setup lang="ts">
import { computed, ref } from "vue";
import { GripVertical, ChevronUp, ChevronDown } from "@lucide/vue";
import { defaultColumns, orderedColumns, type TableColumn } from "../domain/tableColumns";
import type { PointDefinition } from "../domain/pointTables";
import Modal from "./Modal.vue";
const props = defineProps<{ definition: PointDefinition; columns: TableColumn[] }>();
const emit = defineEmits<{ close: []; apply: [columns: TableColumn[]] }>();
const draft = ref(props.columns.map(c => ({ ...c })));
const ordered = computed(() => orderedColumns(draft.value));
const hasVisible = computed(() => draft.value.some(c => c.visible));
const dragging = ref<string>();
const label = (key: string) => props.definition.fields[key].column_label || props.definition.fields[key].label;
function neighbor(column: TableColumn, step: number) {
  const next = ordered.value[ordered.value.findIndex(c => c.key === column.key) + step];
  return next?.frozen === column.frozen ? next : undefined;
}
function move(key: string, target: string) {
  const from = draft.value.findIndex(c => c.key === key), to = draft.value.findIndex(c => c.key === target);
  if (from < 0 || to < 0 || from === to || draft.value[from].frozen !== draft.value[to].frozen) return;
  const [column] = draft.value.splice(from, 1);
  draft.value.splice(to, 0, column);
}
function startDrag(key: string, event: DragEvent) {
  dragging.value = key;
  event.dataTransfer?.setData("text/plain", key);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}
function canDrop(column: TableColumn) {
  return draft.value.find(c => c.key === dragging.value)?.frozen === column.frozen;
}
</script>
<template>
  <Modal title="列设置" @close="emit('close')">
    <div class="modal-body">
      <p class="muted">勾选显示或冻结到左侧。拖动手柄或使用上下按钮调整顺序；冻结列集中在左侧，同类列之间可调整顺序。序号和右侧操作列始终保留。</p>
      <div class="point-column-list" role="list" aria-label="表格列">
        <div v-for="column in ordered" :key="column.key" class="point-column-item" role="listitem" :data-column-key="column.key"
          @dragover="canDrop(column) && $event.preventDefault()"
          @drop.prevent="dragging && move(dragging, column.key); dragging = undefined">
          <button class="icon-btn column-drag-handle" draggable="true" :aria-label="`拖动 ${label(column.key)} 列`"
            @dragstart="startDrag(column.key, $event)" @dragend="dragging = undefined"><GripVertical :size="16" /></button>
          <label class="point-column-visible"><input v-model="column.visible" type="checkbox" :aria-label="`显示 ${label(column.key)}`" />{{ label(column.key) }}</label>
          <label><input v-model="column.frozen" type="checkbox" :disabled="!column.visible" :aria-label="`冻结 ${label(column.key)}`" />冻结</label>
          <button class="icon-btn" :disabled="!neighbor(column, -1)" :aria-label="`上移 ${label(column.key)}`" @click="move(column.key, neighbor(column, -1)!.key)"><ChevronUp :size="16" /></button>
          <button class="icon-btn" :disabled="!neighbor(column, 1)" :aria-label="`下移 ${label(column.key)}`" @click="move(column.key, neighbor(column, 1)!.key)"><ChevronDown :size="16" /></button>
        </div>
      </div>
      <p v-if="!hasVisible" class="notice danger" role="alert">至少保留一列显示。</p>
      <p class="muted">仅保存在当前浏览器，不改变点表数据、协议地址或其他成员的视图。</p>
    </div>
    <div class="modal-footer">
      <button class="button" @click="draft = defaultColumns(definition.columns)">恢复默认</button>
      <button class="button" @click="emit('close')">取消</button>
      <button class="button primary" :disabled="!hasVisible" @click="emit('apply', draft)">应用</button>
    </div>
  </Modal>
</template>
