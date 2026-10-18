<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronRight, FolderUp, LoaderCircle } from "@lucide/vue";
import { api, ApiError, type Row } from "../api";
import Badge from "./Badge.vue";
import Modal from "./Modal.vue";

const emit = defineEmits<{ close: []; done: [result: Row]; error: [message: string] }>();
const preview = ref<Row | null>(null),
  busy = ref(false),
  submitting = ref(false),
  error = ref(""),
  issues = ref<Row[]>([]),
  folderName = ref("");
const allowed = computed(() => !!preview.value?.token && preview.value.allowed !== false && !preview.value.errors?.length);
const action = computed(() => preview.value?.existing_project_id
  ? preview.value.replace_data ? "覆盖项目配置与点表数据" : "覆盖项目配置，保留点表数据"
  : "导入项目");
function report(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : "项目文件夹导入失败";
  issues.value = cause instanceof ApiError && Array.isArray(cause.details.errors)
    ? cause.details.errors.filter((item: unknown) => item && typeof item === "object")
    : [];
  emit("error", error.value);
}
function issueText(issue: Row) {
  const subject = [issue.entity, issue.name || issue.id].filter(value => value != null && value !== "").join(" / ");
  return `${subject ? `${subject}：` : ""}${issue.message || "数据校验未通过"}`;
}
function close() {
  if (!busy.value) emit("close");
}
async function upload(event: Event) {
  if (busy.value) return;
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  if (!files.length) return;
  preview.value = null;
  error.value = "";
  issues.value = [];
  folderName.value = files[0]!.webkitRelativePath.split("/")[0] || files[0]!.name;
  busy.value = true;
  try {
    const body = new FormData();
    for (const file of files) {
      if (!file.webkitRelativePath) throw new Error("请选择完整项目文件夹，保留 project.json 与板卡目录的相对位置。");
      body.append("files", file, file.webkitRelativePath);
    }
    preview.value = await api("/project-folders/preview", "POST", body);
    if (!allowed.value) {
      error.value = preview.value?.errors?.map((item: string | Row) => typeof item === "string" ? item : item.message).join("；") || "项目文件夹检查未通过";
      emit("error", error.value);
    }
  } catch (cause) {
    preview.value = null;
    report(cause);
  } finally {
    busy.value = false;
  }
}
async function commit() {
  if (busy.value || !allowed.value) return;
  busy.value = true;
  submitting.value = true;
  error.value = "";
  issues.value = [];
  try {
    const result = await api("/project-folders/commit", "POST", { token: preview.value!.token });
    emit("done", { ...result, created: !preview.value!.existing_project_id });
  } catch (cause) {
    preview.value = null;
    report(cause);
  } finally {
    submitting.value = false;
    busy.value = false;
  }
}
</script>
<template>
  <Modal title="导入项目文件夹" wide @close="close">
    <div class="modal-body project-folder-import">
      <div class="import-steps" aria-label="文件夹导入步骤">
        <span :class="{ current: !preview }">01 选择文件夹</span>
        <ChevronRight :size="15" />
        <span :class="{ current: preview && !submitting }">02 核对覆盖范围</span>
        <ChevronRight :size="15" />
        <span :class="{ current: submitting }">03 确认导入</span>
      </div>
      <p class="notice">
        选择包含 project.json 和板卡目录的完整项目文件夹。项目标识相同时覆盖服务器配置；新标识会导入为新项目。
        包含导出脚本生成的 project.dump 时同步替换该项目的点表数据，没有 Dump 时保留现有点表数据。
      </p>
      <label class="upload-area">
        <div><FolderUp :size="30" /></div>
        <strong>{{ busy ? submitting ? "正在导入项目…" : "正在检查项目文件夹…" : preview ? "重新选择项目文件夹" : "选择项目文件夹" }}</strong>
        <span>先检查文件和覆盖范围，再确认写入。</span>
        <input type="file" webkitdirectory multiple :disabled="busy" aria-label="选择项目文件夹" @change="upload" />
      </label>
      <section v-if="preview" class="folder-preview" aria-label="项目文件夹导入预览">
        <div class="file-info">
          <FolderUp :size="28" />
          <div><strong>{{ preview.name }}</strong><small>项目标识：{{ preview.key }} · 本地文件夹：{{ folderName }}</small></div>
          <Badge :tone="preview.existing_project_id ? 'amber' : 'teal'">{{ preview.existing_project_id ? "覆盖已有项目" : "导入新项目" }}</Badge>
        </div>
        <dl class="folder-impact">
          <div><dt>项目配置</dt><dd>{{ preview.existing_project_id ? "用所选文件夹替换" : "保存为新的项目目录" }}</dd></div>
          <div><dt>点表数据</dt><dd>{{ preview.replace_data ? "使用项目 Dump 中的数据" : preview.existing_project_id ? "保留当前数据库中的数据" : "创建空点表，可在网页中添加" }}</dd></div>
          <div v-if="preview.existing_project_id"><dt>当前版本</dt><dd>REV {{ preview.revision }}</dd></div>
        </dl>
        <p v-if="preview.replace_data" class="notice danger">{{ preview.existing_project_id ? "此文件夹包含项目 Dump，确认后将替换该项目当前的点表数据。" : "此文件夹包含项目 Dump，确认后将导入其中的点表数据。" }}</p>
        <p v-if="preview.warnings?.length" class="notice">{{ preview.warnings.join("；") }}</p>
        <details v-if="preview.files?.length" class="folder-files">
          <summary>查看 {{ preview.files.length }} 个导入文件</summary>
          <ul><li v-for="path in preview.files" :key="path" class="mono">{{ path }}</li></ul>
        </details>
      </section>
      <p v-if="error" class="notice danger" role="alert">{{ error }}</p>
      <div v-if="issues.length" class="notice danger" aria-label="导入校验详情">
        <p v-for="(issue, index) in issues.slice(0, 5)" :key="index">{{ issueText(issue) }}</p>
        <p v-if="issues.length > 5">另有 {{ issues.length - 5 }} 项校验问题；请修正后重新检查。</p>
      </div>
      <p v-if="error && !preview" class="muted">请处理提示的问题后重新选择文件夹，重新检查再导入。</p>
    </div>
    <div class="modal-footer">
      <button class="button" :disabled="busy" @click="close">取消</button>
      <button v-if="allowed" class="button primary" :disabled="busy" @click="commit">
        <LoaderCircle v-if="busy" class="spin" :size="16" /><FolderUp v-else :size="16" />{{ action }}
      </button>
    </div>
  </Modal>
</template>
<style scoped>
.project-folder-import > .notice { margin-bottom: 16px; }
.folder-preview { margin-top: 20px; }
.folder-impact { display: grid; gap: 12px; margin: 20px 0; font-size: 13px; }
.folder-impact > div { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 16px; }
.folder-impact dt { color: var(--muted); }
.folder-impact dd { margin: 0; }
.folder-files { margin-top: 16px; font-size: 12px; }
.folder-files summary { cursor: pointer; }
.folder-files ul { max-height: 180px; overflow: auto; padding-left: 20px; }
.folder-files li { margin: 6px 0; overflow-wrap: anywhere; }
</style>
