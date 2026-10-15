<script setup lang="ts">
withDefaults(defineProps<{ tone?: string }>(), { tone: "gray" });
</script>
<template>
  <span :class="['badge', tone]"><slot /></span>
</template>
