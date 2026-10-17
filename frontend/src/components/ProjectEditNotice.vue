<script setup lang="ts">
import { inject, type Ref } from "vue";
import { LockKeyhole } from "@lucide/vue";
import type { EditLockFailure } from "../domain/editLock";

type ProjectEditLock = {
  eligible: Ref<boolean>;
  owned: Ref<boolean>;
  pending: Ref<boolean>;
  checking: Ref<boolean>;
  failure: Ref<EditLockFailure | null>;
  occupied: Ref<boolean>;
  message: Ref<string>;
  acquire: () => Promise<void>;
  retry: () => Promise<void>;
};

const lock = inject<ProjectEditLock | null>("project-edit-lock", null);
</script>

<template>
  <div
    v-if="
      lock && (lock.eligible.value || lock.failure.value) && !lock.owned.value
    "
    class="project-edit-notice"
    role="status"
    aria-live="polite"
  >
    <LockKeyhole :size="16" aria-hidden="true" />
    <span>{{ lock.message.value }}</span>
    <button
      v-if="lock.failure.value?.retryable"
      type="button"
      class="button small"
      :disabled="lock.checking.value || lock.pending.value"
      @click="lock.retry"
    >
      {{ lock.checking.value ? "检查中…" : "重试检查" }}
    </button>
    <button
      v-else-if="!lock.failure.value && lock.eligible.value"
      type="button"
      class="button small"
      :disabled="lock.occupied.value || lock.pending.value"
      @click="lock.acquire"
    >
      {{ lock.pending.value ? "获取中…" : "开始编辑" }}
    </button>
  </div>
</template>

<style scoped>
.project-edit-notice {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 16px;
  border-bottom: 1px solid #e8d8b6;
  background: #fff9ed;
  color: #856021;
  font-size: 13px;
  line-height: 1.5;
}
.project-edit-notice > span {
  flex: 1;
  min-width: 0;
}
.project-edit-notice > svg,
.project-edit-notice > button {
  flex-shrink: 0;
}
.project-edit-notice > button {
  white-space: nowrap;
}
</style>
