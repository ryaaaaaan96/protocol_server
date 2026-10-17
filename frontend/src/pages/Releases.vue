<script setup lang="ts">
import { ref, watch } from "vue";
import {
  FileCode2,
  Code2,
  LoaderCircle,
  AlertTriangle,
  ArrowRight,
  Copy,
  CheckCircle2,
  GitBranch,
  ArrowDownToLine,
} from "@lucide/vue";
import { api, revisionConflict, time, type Row } from "../api";
import Badge from "../components/Badge.vue";
import Empty from "../components/Empty.vue";
const props = defineProps<{ pid: number; tick: number; canWrite: boolean }>();
const emit = defineEmits<{
  notify: [message: string, error?: boolean];
  refresh: [];
  validate: [];
}>();
const list = ref<Row[]>([]),
  generated = ref<Row | null>(null),
  file = ref("collect.c"),
  loading = ref(false),
  name = ref(""),
  publishing = ref(false);
watch(
  () => [props.pid, props.tick],
  () => {
    api(`/projects/${props.pid}/releases`)
      .then((v) => (list.value = v))
      .catch((e) => emit("notify", e.message, true));
    generated.value = null;
  },
  { immediate: true },
);
async function generate() {
  loading.value = true;
  try {
    generated.value = await api(`/projects/${props.pid}/generate`);
    file.value = Object.keys(generated.value?.files || {})[0] || "";
    emit("notify", generated.value?.blocked ? "生成失败，请先修复校验错误" : "配置预览已生成", !!generated.value?.blocked);
  } catch (e) {
    emit("notify", (e as Error).message, true);
  } finally {
    loading.value = false;
  }
}
async function publish() {
  if (!props.canWrite || publishing.value) return;
  publishing.value = true;
  try {
    await api(`/projects/${props.pid}/releases`, "POST", { name: name.value, revision: generated.value!.revision });
    name.value = "";
    emit("refresh");
    emit("notify", "配置版本已冻结，可以下载交付");
  } catch (e) {
    emit("notify", (e as Error).message, true);
    if (revisionConflict(e)) {
      generated.value = null;
      emit("refresh");
    }
  } finally {
    publishing.value = false;
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(
      generated.value?.files[file.value] || "",
    );
    emit("notify", "已复制当前文件");
  } catch {
    emit("notify", "浏览器未允许复制，请下载版本包", true);
  }
}
</script>
<template>
  <section class="panel generation-panel">
    <div class="panel-heading">
      <div>
        <h3><FileCode2 :size="19" />配置生成</h3>
        <p>按板卡分别生成协议契约、内部信号、采集转发、范围和设备连接配置。</p>
      </div>
      <button class="button primary" :disabled="loading" @click="generate">
        <LoaderCircle v-if="loading" class="spin" :size="16" /><Code2
          v-else
          :size="16"
        />生成预览
      </button>
    </div>
    <div v-if="generated?.blocked" class="generation-blocked">
      <AlertTriangle :size="25" />
      <div>
        <strong>{{ generated.validation.errors }} 个错误阻止了配置生成</strong>
        <p>原始数据已保留。先修复不一致的字段，再生成可用于工程的配置。</p>
      </div>
      <button class="button" @click="emit('validate')">
        前往校验中心<ArrowRight :size="15" />
      </button>
    </div>
    <template v-else-if="generated"
      ><div class="code-tabs">
        <button
          v-for="k in Object.keys(generated.files)"
          :key="k"
          :class="{ selected: k === file }"
          @click="file = k"
        >
          <FileCode2 :size="14" />{{ k }}</button
        ><button class="icon-btn" aria-label="复制当前文件" @click="copy">
          <Copy :size="15" />
        </button>
      </div>
      <pre class="code-preview">{{ generated.files[file] }}</pre>
      <div class="release-bar">
        <div>
          <CheckCircle2 :size="18" /><span
            >校验通过 · {{ generated.validation.warnings }} 条提示</span
          >
        </div>
        <form v-if="canWrite" @submit.prevent="publish">
          <input
            aria-label="发布版本名称"
            placeholder="版本名称，例如 v1.0.0"
            v-model="name"
            maxlength="80"
            required
          /><button class="button primary" :disabled="publishing">
            <GitBranch :size="15" />创建版本
          </button>
        </form>
      </div></template
    ><Empty
      v-else
      title="将当前点表转换为工程配置"
      detail="预览会先运行完整校验；生成结果可以创建为不可变版本。"
    />
  </section>
  <section class="panel section-gap">
    <div class="panel-heading">
      <div>
        <h3>版本记录</h3>
        <p>每个版本保存点表快照、生成文件和 SHA-256 校验值。</p>
      </div>
      <Badge>{{ list.length }} 个版本</Badge>
    </div>
    <div v-if="list.length" class="release-list">
      <div v-for="r in list" :key="r.id" class="release-item">
        <span class="release-icon"><GitBranch :size="20" /></span>
        <div>
          <h4>
            {{ r.name }}<Badge tone="teal">REV {{ r.revision }}</Badge>
          </h4>
          <small>{{ time(r.created_at) }}</small
          ><code>SHA-256 {{ r.sha256.slice(0, 32) }}…</code>
        </div>
        <a
          class="button small"
          :href="`/api/projects/${pid}/releases/${r.id}/download`"
          ><ArrowDownToLine :size="15" />下载配置包</a
        >
      </div>
    </div>
    <Empty
      v-else
      title="还没有发布版本"
      detail="完成校验并生成预览后，创建第一个配置版本。"
    />
  </section>
</template>
