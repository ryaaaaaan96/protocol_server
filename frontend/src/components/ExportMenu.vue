<script setup lang="ts">
import { ref } from "vue";
import { Download, ChevronDown, LoaderCircle } from "@lucide/vue";
import ContextMenu from "./ContextMenu.vue";
import { downloadExport, saveFile, type TableExport } from "../domain/tableExport";
const props = defineProps<{
  pid: number;
  filename: string;
  prepare?: () => TableExport;
  disabled?: boolean;
}>();
const emit = defineEmits<{ notify: [message: string, error?: boolean] }>();
const busy = ref(false), menu = ref<{ x: number; y: number } | null>(null);
function open(event: MouseEvent) {
  if (props.disabled || busy.value) return;
  (event.currentTarget as HTMLElement).focus();
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  menu.value = { x: rect.left, y: rect.bottom };
}
async function download(format: string) {
  menu.value = null;
  if (props.disabled || busy.value) return;
  busy.value = true;
  const filename = `${props.filename}.${format}`, pid = props.pid;
  try {
    if (props.prepare) {
      const table = props.prepare();
      if (format === "json") saveFile(new Blob([JSON.stringify(table, null, 2)], { type: "application/json;charset=utf-8" }), filename);
      else await downloadExport(`/projects/${pid}/export-table`, filename, table);
    } else await downloadExport(`/projects/${pid}/export${format === "xlsx" ? ".xlsx" : ""}`, filename);
    emit("notify", `已开始下载 ${filename}`);
  } catch (cause) { emit("notify", (cause as Error).message, true); }
  finally { busy.value = false; }
}
</script>
<template>
  <button class="button small" :aria-label="prepare ? '导出当前表格' : '导出项目'" aria-haspopup="menu" :aria-expanded="!!menu"
    :disabled="disabled || busy" :title="prepare ? '导出当前筛选下所有行与可见列；未保存修改请先保存或放弃' : '导出当前项目已保存的数据'" @click="open">
    <LoaderCircle v-if="busy" class="spin" :size="15" /><Download v-else :size="15" />{{ busy ? '导出中…' : prepare ? '导出' : '导出项目' }}<ChevronDown :size="13" />
  </button>
  <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" label="导出格式" :items="[{ key: 'json', label: '导出 JSON' }, { key: 'xlsx', label: '导出 Excel (.xlsx)' }]" @select="download" @close="menu = null" />
</template>
