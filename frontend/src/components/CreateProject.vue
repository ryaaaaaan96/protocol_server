<script setup lang="ts">
import { ref } from "vue";
import { api, type Row } from "../api";
import Modal from "./Modal.vue";
import Field from "./Field.vue";
const emit = defineEmits<{ close: []; done: [project: Row] }>();
const name = ref(""),
  description = ref(""),
  busy = ref(false),
  error = ref("");
async function save() {
  busy.value = true;
  try {
    emit(
      "done",
      await api("/projects", "POST", {
        name: name.value,
        description: description.value,
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
          项目将预置本地控制器与 8 个 DSP 模块，可在设备配置中调整地址段。
        </div>
        <div v-if="error" class="notice danger">{{ error }}</div>
      </div>
      <div class="modal-footer">
        <button type="button" class="button" @click="emit('close')">取消</button
        ><button class="button primary" :disabled="busy">创建项目</button>
      </div>
    </form></Modal
  >
</template>
