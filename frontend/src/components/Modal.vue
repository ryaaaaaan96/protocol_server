<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { X } from "@lucide/vue";
import ProjectEditNotice from "./ProjectEditNotice.vue";
defineProps<{ title: string; wide?: boolean; lockGuard?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
onMounted(() => dialog.value?.showModal());
onBeforeUnmount(() => dialog.value?.close());
</script>
<template>
  <dialog
    ref="dialog"
    :class="['modal', { wide }]"
    @cancel.prevent="emit('close')"
  >
    <div class="modal-head">
      <h2>{{ title }}</h2>
      <button class="icon-btn" aria-label="关闭" @click="emit('close')">
        <X :size="20" />
      </button>
    </div>
    <ProjectEditNotice v-if="lockGuard" />
    <slot />
  </dialog>
</template>
