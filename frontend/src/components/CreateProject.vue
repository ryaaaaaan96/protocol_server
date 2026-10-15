<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, type Row } from "../api";
import Modal from "./Modal.vue";
import Field from "./Field.vue";
const emit = defineEmits<{ close: []; done: [project: Row] }>();
const name = ref(""),
  description = ref(""),
  config = ref(""),
  busy = ref(false),
  error = ref("");
onMounted(async () => {
  try {
    config.value = JSON.stringify(await api("/project-template"), null, 2);
  } catch (e) {
    error.value = (e as Error).message;
  }
});
async function save() {
  busy.value = true;
  try {
    emit(
      "done",
      await api("/projects", "POST", {
        name: name.value,
        description: description.value,
        config: JSON.parse(config.value),
      }),
    );
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <Modal title="创建项目" @close="emit('close')"
    ><form @submit.prevent="save">
      <div class="modal-body">
        <Field label="项目名称"
          ><input
            v-model="name"
            required
            maxlength="120"
            placeholder="例如 UPM 协议配置" /></Field
        ><Field label="项目说明">
          <textarea
            v-model="description"
            rows="3"
            placeholder="描述设备型号、协议范围或项目用途"
          />
        </Field>
        <div class="notice">
          项目按 JSON 定义板卡类型及协议挂载关系，每种类型只维护一份点表。
        </div>
        <details class="create-project-config">
          <summary>项目 JSON · CSU / UPM / DSP</summary>
          <textarea
            v-model="config"
            aria-label="新项目 JSON 配置"
            class="json-editor"
            spellcheck="false"
          />
        </details>
        <div v-if="error" class="notice danger">{{ error }}</div>
      </div>
      <div class="modal-footer">
        <button type="button" class="button" @click="emit('close')">取消</button
        ><button class="button primary" :disabled="busy || !config">
          创建项目
        </button>
      </div>
    </form></Modal
  >
</template>
