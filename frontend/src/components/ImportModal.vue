<script setup lang="ts">
import { computed, ref } from "vue";
import {
  ChevronRight,
  Upload,
  FileSpreadsheet,
  Database,
  LoaderCircle,
} from "@lucide/vue";
import { api, type Row } from "../api";
import Modal from "./Modal.vue";
import Badge from "./Badge.vue";
const props = defineProps<{ pid: number; canWrite: boolean }>();
const emit = defineEmits<{ close: []; done: [] }>();
const board = ref("DSP");
const preview = ref<Row | null>(null),
  busy = ref(false),
  error = ref(""),
  replace = ref(false);
const counts = computed(() => !preview.value ? [] : preview.value.import_scope === "upm" ? [
  ["LOCAL 内部点", preview.value.local_count], ["DSP 模板内部点", preview.value.dsp_count],
  ["UPP 采集映射", preview.value.collect_count], ["对外转发映射", preview.value.transmit_count],
] : [
  ["DSP 内部点", preview.value.dsp_count ?? preview.value.point_count],
  ["UPP 转发映射", preview.value.transmit_count],
]);
async function upload(event: Event) {
  if (!props.canWrite || busy.value) return;
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  busy.value = true;
  error.value = "";
  preview.value = null;
  replace.value = false;
  const f = new FormData();
  f.append("file", file);
  try {
    preview.value = await api(
      `/projects/${props.pid}/imports/preview?board=${board.value}`,
      "POST",
      f,
    );
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function commit() {
  if (!props.canWrite || busy.value || !preview.value || !replace.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(
      `/projects/${props.pid}/imports/${preview.value!.id}/commit`,
      "POST",
      { replace: replace.value },
    );
    emit("done");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <Modal title="导入 Excel 点表" wide lock-guard @close="emit('close')"
    ><div class="modal-body">
      <p v-if="!canWrite" class="notice">当前为只读，请关闭窗口并重新取得编辑权后导入。</p>
      <div class="import-steps">
        <span :class="{ current: !preview }">01 选择文件</span
        ><ChevronRight :size="15" /><span :class="{ current: preview }"
          >02 核对预览</span
        ><ChevronRight :size="15" /><span>03 写入数据库</span>
      </div>
      <label v-if="!preview" class="field">导入板卡<select v-model="board" aria-label="导入板卡" :disabled="busy"><option value="DSP">DSP 功率板</option><option value="UPM">UPM 控制板</option></select></label>
      <template v-if="!preview"
        ><label class="upload-area"
          ><div><Upload :size="30" /></div>
          <strong>{{ busy ? "正在解析工作簿…" : "选择 DC-UPS 测点工作簿" }}</strong
          ><span>支持 .xlsx，最大 15 MB。源文件保持不变。</span
          ><input
            type="file"
            accept=".xlsx"
            :disabled="busy || !canWrite"
            aria-label="选择 Excel 文件"
            @change="upload"
        /></label>
        <div class="notice">
          <strong>仅更新 {{ board }} 侧点表</strong>
          <p v-if="board === 'DSP'">读取“DSP内部数据”和“UPM-DSP采集数据”，更新 DSP 内部点和转发映射。</p>
          <p v-else>读取“UPM单板测点”“UPM-DSP采集数据”“CSU-UPM采集数据”及公共 sigID 映射表，更新 UPM 内部点、采集和两种转发映射。</p>

        </div></template
      ><template v-else
        ><div class="file-info">
          <FileSpreadsheet :size="28" />
          <div>
            <strong>{{ preview.filename }}</strong
            ><small class="mono"
              >SHA-256 · {{ preview.sha256.slice(0, 24) }}…</small
            >
          </div>
          <Badge tone="teal">解析完成</Badge>
        </div>
        <div class="import-counts">
          <div
            v-for="[label, value] in counts"
            :key="label"
          >
            <strong>{{ value }}</strong
            ><small>{{ label }}</small>
          </div>
        </div>
        <p class="notice">本次替换 {{ preview.import_scope === 'upm' ? 'UPM' : 'DSP' }} 板卡点表，其他板卡不受影响。</p>
        <div class="notice">
          <p v-for="w in preview.warnings" :key="w">{{ w }}</p>
        </div>
        <h4>预览前 6 条</h4>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>测点名称</th>
                <th>设备</th>
                <th>枚举</th>
                <th>类型</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(p, i) in preview.sample" :key="i">
                <td>{{ p.name }}</td>
                <td>{{ p.board_key || 'DSP' }}</td>
                <td class="mono">{{ p.enum_name }}</td>
                <td>{{ p.internal_type ?? p.data_type ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <label class="confirm-checkbox"
          ><input type="checkbox" v-model="replace" /><span
            >{{ preview.import_scope === 'upm'
              ? '确认替换 UPM 内部点、UPP 采集表及两种对外转发表，保留项目拓扑、DSP 及其他板卡数据。'
              : '确认替换 DSP 内部数据和 DSP UPP 转发表，保留项目拓扑、UPM 及其他板卡数据。' }}修改前后内容保留在历史记录中。</span
          ></label
        ></template
      >
      <div v-if="error" class="notice danger" role="alert">{{ error }}</div>
    </div>
    <div class="modal-footer">
      <button class="button" @click="emit('close')">取消</button
      ><template v-if="preview"
        ><button
          class="button"
          @click="
            preview = null;
            error = '';
            replace = false;
          "
        >
          重新选择</button
        ><button
          class="button primary"
          :disabled="busy || !canWrite || !replace"
          @click="commit"
        >
          <LoaderCircle v-if="busy" class="spin" :size="16" /><Database
            v-else
            :size="16"
          />确认导入 {{ preview.point_count }} 个测点
        </button></template
      >
    </div></Modal
  >
</template>
