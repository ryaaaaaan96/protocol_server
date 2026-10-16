<script setup lang="ts">
import { ref } from "vue";
import { api, revisionConflict, type Row } from "../api";
import { pointText } from "../domain/pointTables";
import Modal from "./Modal.vue";
const props = defineProps<{pid:number; preview:Row; title:string}>();
const emit = defineEmits<{close:[]; done:[merged:boolean]; error:[message:string]; conflict:[]}>();
const busy = ref(false), error = ref("");
async function commit() {
  busy.value = true;
  try {
    const result = await api(`/projects/${props.pid}/changes/${props.preview.id}/commit`, "POST", {});
    emit("done", !!(result.merged || props.preview.merged));
  } catch(e) {
    error.value = (e as Error).message;
    emit("error", error.value);
    if (revisionConflict(e)) emit("conflict");
  }
  finally { busy.value = false; }
}
function changes(change:Row) {
  const before = change.before || {}, after = change.after || {};
  return Object.keys({...before,...after}).filter(k => !["project_id","raw_json"].includes(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map(k => `${({display_order:"显示顺序",ordinal:"协议排列",effective_address:"协议地址"} as Row)[k] || k}：${pointText(before[k])} → ${pointText(after[k])}`).join("；");
}
</script>
<template>
  <Modal :title="title" wide @close="!busy && emit('close')">
    <div class="modal-body">
      <div :class="['notice', {danger:!preview.allowed}]" role="status">
        {{ preview.allowed ? '关联检查通过，确认后保存。' : '此修改不能提交，请调整后重新检查。' }}
        <p v-for="(problem,i) in preview.errors" :key="i">{{ problem.message }}</p>
      </div>
      <p v-if="preview.merged" class="notice">已合并其他成员的无关修改，请确认最新关联影响。</p>
      <p v-if="preview.impact.affected_types?.length">涉及板卡：{{ preview.impact.affected_types.map((t:Row) => t.name || t.code).join('、') }}</p>
      <p v-if="preview.impact.affected_contexts?.length">涉及设备：{{ preview.impact.affected_contexts.map((c:Row) => `${c.name} [${c.dev_id}]`).join('、') }}</p>
      <p>关联变更 {{ preview.impact.count }} 项</p>
      <div class="impact-list">
        <article v-for="(change,i) in preview.impact.changes" :key="i"><strong>{{ change.after?.name || change.after?.signal_name || change.key }}</strong><p>{{ changes(change) }}</p></article>
      </div>
      <p v-if="preview.impact.count > 200" class="muted">显示前 200 项；全部关联已检查。</p>
      <div v-if="error" class="notice danger" role="alert">{{ error }}。请返回并重新载入数据后检查。</div>
    </div>
    <div class="modal-footer">
      <button class="button" :disabled="busy" @click="emit('close')">返回调整</button>
      <button v-if="preview.allowed && !error" class="button primary" :disabled="busy" @click="commit">确认提交</button>
    </div>
  </Modal>
</template>
