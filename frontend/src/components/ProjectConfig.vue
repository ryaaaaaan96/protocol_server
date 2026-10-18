<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { api, revisionConflict, type Row } from "../api";
import Modal from "./Modal.vue";
import { Download, RefreshCw, FileJson } from "@lucide/vue";
const props = defineProps<{ pid: number; graph: Row; canWrite: boolean }>();
const emit = defineEmits<{ close: []; done: []; error: [message: string]; conflict: [] }>();
const source = ref<Row | null>(null),
  error = ref(""),
  busy = ref(false),
  preview = ref<Row | null>(null);
const value = computed(() => source.value ? JSON.stringify(source.value.config, null, 2) : "");
function report(e: unknown) {
  error.value = (e as Error).message;
  emit("error", error.value);
  if (revisionConflict(e)) emit("conflict");
}
async function load() {
  busy.value = true;
  error.value = "";
  preview.value = null;
  source.value = null;
  try {
    source.value = await api(`/projects/${props.pid}/configuration/source`);
  } catch (e) {
    report(e);
  } finally {
    busy.value = false;
  }
}
onMounted(load);
function download() {
  if (!source.value) return;
  const blob = new Blob([value.value + "\n"], { type: "application/json" }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = `topology-${source.value.key}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
async function review() {
  if (!props.canWrite || busy.value || !source.value) return;
  busy.value = true;
  error.value = "";
  preview.value = null;
  try {
    preview.value = await api(`/projects/${props.pid}/changes/preview`, "POST", {
      revision: props.graph.revision,
      entity: "project_config",
      operation: "update",
      values: source.value.config,
      expected: { source_sha256: source.value.sha256 },
    });
    if (preview.value && !preview.value.allowed) {
      emit("error", preview.value.errors.map((e: Row) => e.message).join("；"));
    }
  } catch (e) {
    report(e);
  } finally {
    busy.value = false;
  }
}
async function commit() {
  if (!props.canWrite || busy.value || !preview.value?.allowed) return;
  busy.value = true;
  try {
    await api(`/projects/${props.pid}/changes/${preview.value.id}/commit`, "POST", {});
    emit("done");
  } catch (e) {
    report(e);
    preview.value = null;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <Modal title="项目拓扑配置" wide lock-guard @close="emit('close')">
    <form @submit.prevent="review">
      <div class="modal-body project-json">
        <p class="notice">
          通过 SSH 修改服务器项目文件中的 topology，然后重新读取、检查并导入。
          项目和板卡定义会实时读取，无需重启；拓扑变更在检查并导入后生效，点表展示定义刷新页面即可更新。
        </p>
        <p v-if="source" class="muted">项目目录：{{ source.key }} · project.json → topology</p>
        <div class="inline json-actions">
          <button type="button" class="button" :disabled="busy" @click="load">
            <RefreshCw :size="16" />重新读取项目文件
          </button>
          <button type="button" class="button" :disabled="busy || !source" @click="download">
            <Download :size="16" />下载拓扑 JSON
          </button>
        </div>
        <textarea
          :value="value"
          aria-label="项目拓扑内容"
          class="json-editor"
          spellcheck="false"
          readonly
        />
        <p v-if="error" class="notice danger" role="alert">{{ error }}</p>
        <div v-if="preview" :class="['notice', { danger: !preview.allowed }]" role="status">
          <strong>{{ preview.allowed ? "配置检查通过" : "配置不能导入" }}</strong>
          <p v-for="(e, i) in preview.errors" :key="i">{{ e.message }}</p>
          <p v-if="preview.allowed">
            {{ preview.impact.affected_types?.map((t: Row) => `${t.code} × ${t.quantity}`).join(" · ") }}
          </p>
          <p v-if="preview.allowed">确认后导入已检查的拓扑与挂载关系。</p>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="button" @click="emit('close')">关闭</button>
        <button v-if="canWrite" class="button" :disabled="busy || !source">
          <FileJson :size="16" />检查项目配置
        </button>
        <button v-if="canWrite && preview?.allowed" type="button" class="button primary" :disabled="busy" @click="commit">
          导入已检查的拓扑
        </button>
      </div>
    </form>
  </Modal>
</template>
