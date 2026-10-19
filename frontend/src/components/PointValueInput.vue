<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { choiceLabel, pointChoices, type PointTableData } from "../domain/pointTables";
import type { Row } from "../api";
const props = defineProps<{
  data: PointTableData; fieldKey: string; values: Row; autofocus?: boolean; disabled?: boolean;
}>();
const emit = defineEmits<{ change: [value: unknown] }>();
const root = ref<HTMLElement>();
const field = computed(() => props.data.definition.fields[props.fieldKey]);
const choices = computed(() => pointChoices(props.data, props.fieldKey, props.values));
watch(() => props.autofocus, async (active) => {
  if (active) {
    await nextTick();
    root.value?.querySelector<HTMLElement>("input,select,textarea")?.focus();
  }
}, { immediate: true });
function set(event: Event) {
  const input = event.target as HTMLInputElement;
  emit("change", field.value.type === "boolean" ? input.checked
    : input.value === "" && (field.value.nullable || field.value.reference || field.value.type === "number") ? null
    : field.value.type === "number" ? Number(input.value) : input.value);
}
</script>
<template>
  <div ref="root" class="point-value-input">
    <select v-if="field.reference" :disabled="disabled" :aria-label="field.label" :value="values[fieldKey] ?? ''" @change="set">
      <option value="">请选择</option>
      <option v-for="row in choices" :key="row.id" :value="row.id">{{ choiceLabel(row) }}</option>
    </select>
    <select v-else-if="field.options" :disabled="disabled" :aria-label="field.label" :value="values[fieldKey] ?? ''" @change="set">
      <option v-if="field.nullable" value="">未指定</option>
      <option v-for="option in field.options" :key="option" :value="option">{{ option }}</option>
    </select>
    <input v-else-if="field.type === 'boolean'" :disabled="disabled" type="checkbox" :aria-label="field.label" :checked="!!values[fieldKey]" @change="set" />
    <textarea v-else-if="field.multiline" :disabled="disabled" :aria-label="field.label" :value="values[fieldKey] ?? ''" rows="4" @input="set" />
    <input v-else :disabled="disabled" :type="field.type === 'number' ? 'number' : 'text'" :step="field.type === 'number' ? 'any' : undefined" :aria-label="field.label" :value="values[fieldKey] ?? ''" :placeholder="field.nullable ? '留空表示未指定' : ''" @input="set" />
    <small v-if="field.hint">{{ field.hint }}</small>
  </div>
</template>
