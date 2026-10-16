<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { AlertTriangle, CheckCircle2, X } from "@lucide/vue";
defineProps<{ message: string; error: boolean }>();
const emit = defineEmits<{ close: [] }>();
const target = ref<HTMLElement>(document.body);
// Native modal dialogs are above all ordinary z-index layers. Keep the notice
// inside the active dialog, then move it back when that dialog closes.
function updateTarget() {
  const dialogs = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
  target.value = dialogs[dialogs.length - 1] || document.body;
}
const observer = new MutationObserver(updateTarget);
onMounted(() => {
  updateTarget();
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
});
onBeforeUnmount(() => observer.disconnect());
</script>
<template>
  <Teleport :to="target">
    <div :class="['toast', { error }]" :role="error ? 'alert' : 'status'">
      <AlertTriangle v-if="error" :size="18" /><CheckCircle2 v-else :size="18" />
      <span>{{ message }}</span>
      <button class="icon-btn" aria-label="关闭提示" @click="emit('close')"><X :size="16" /></button>
    </div>
  </Teleport>
</template>
