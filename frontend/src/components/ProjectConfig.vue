<script setup lang="ts">
import { ref, onMounted, watch } from "vue";
import { api, revisionConflict, type Row } from "../api";
import Modal from "./Modal.vue";
import { Upload, Download, FileJson } from "@lucide/vue";
const props = defineProps<{ pid: number; graph: Row; canWrite: boolean }>();
const emit = defineEmits<{ close: []; done: []; error: [message:string]; conflict: [] }>();
const value = ref(""),
  error = ref(""),
  busy = ref(false),
  preview = ref<Row | null>(null);
onMounted(async () => {
  try {
    value.value = JSON.stringify(
      props.graph.project_config || (await api("/project-template")),
      null,
      2,
    );
  } catch (e) {
    error.value = (e as Error).message;
    emit("error", error.value);
    if (revisionConflict(e)) emit("conflict");
  }
});
watch(value, () => {
  preview.value = null;
  error.value = "";
});
async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 65536) {
    error.value = "项目配置文件不能超过 64 KB";
    return;
  }
  value.value = await file.text();
}
function download() {
  try {
    const blob = new Blob(
        [JSON.stringify(JSON.parse(value.value), null, 2) + "\n"],
        { type: "application/json" },
      ),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = `project-${props.pid}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    error.value = "JSON 格式无效，请先修正。";
  }
}
async function review() {
  busy.value = true;
  error.value = "";
  try {
    preview.value = await api(
      `/projects/${props.pid}/changes/preview`,
      "POST",
      {
        revision: props.graph.revision,
        entity: "project_config",
        operation: "update",
        values: JSON.parse(value.value),
      },
    );
    if (preview.value && !preview.value.allowed) emit("error", preview.value.errors.map((e:Row) => e.message).join("；"));
  } catch (e) {
    error.value = (e as Error).message;
    emit("error", error.value);
    if (revisionConflict(e)) emit("conflict");
  } finally {
    busy.value = false;
  }
}
async function commit() {
  busy.value = true;
  try {
    await api(
      `/projects/${props.pid}/changes/${preview.value!.id}/commit`,
      "POST",
      {},
    );
    emit("done");
  } catch (e) {
    error.value = (e as Error).message;
    emit("error", error.value);
    if (revisionConflict(e)) emit("conflict");
    preview.value = null;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <Modal title="项目 JSON 配置" wide @close="emit('close')"
    ><form @submit.prevent="review">
      <div class="modal-body project-json">
        <p class="notice">
          每种板卡维护一份点表。quantity 表示每个上级挂载的数量， connections
          可填写多组协议与传输方式，数量只计算一次；空数组表示待配置。
        </p>
        <div class="inline json-actions">
          <label v-if="canWrite" class="button"
            ><Upload :size="16" />导入 JSON<input
              type="file"
              accept=".json,application/json"
              aria-label="导入项目 JSON"
              @change="upload"
              hidden
              :disabled="busy" /></label
          ><button type="button" class="button" @click="download">
            <Download :size="16" />导出 JSON
          </button>
        </div>
        <textarea
          v-model="value"
          aria-label="项目 JSON 内容"
          class="json-editor"
          spellcheck="false"
          :readonly="!canWrite"
          :disabled="busy"
        />
        <p v-if="error" class="notice danger" role="alert">{{ error }}</p>
        <div
          v-if="preview"
          :class="['notice', { danger: !preview.allowed }]"
          role="status"
        >
          <strong>{{
            preview.allowed ? "配置检查通过" : "配置不能提交"
          }}</strong>
          <p v-for="(e, i) in preview.errors" :key="i">{{ e.message }}</p>
          <p v-if="preview.allowed">
            {{
              preview.impact.affected_types
                ?.map((t: Row) => `${t.code} × ${t.quantity}`)
                .join(" · ")
            }}
          </p>
          <p v-if="preview.allowed">更新挂载关系与类型配置，现有点表保留。</p>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="button" @click="emit('close')">关闭</button
        ><button v-if="canWrite" class="button" :disabled="busy || !value">
          <FileJson :size="16" />检查项目配置</button
        ><button
          v-if="canWrite && preview?.allowed"
          type="button"
          class="button primary"
          :disabled="busy"
          @click="commit"
        >
          应用项目配置
        </button>
      </div>
    </form></Modal
  >
</template>
