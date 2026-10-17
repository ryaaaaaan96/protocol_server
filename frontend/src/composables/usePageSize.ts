import { ref, watch, type Ref } from "vue";

export const pageSizeOptions = [25, 50, 100, 200];

export function usePageSize(storageKey: Ref<string>) {
  const pageSize = ref(50);
  watch(storageKey, key => {
    let saved = 50;
    try { saved = Number(localStorage.getItem(key)); } catch {}
    pageSize.value = pageSizeOptions.includes(saved) ? saved : 50;
  }, { immediate: true });

  function setPageSize(size: number) {
    if (!pageSizeOptions.includes(size)) return false;
    pageSize.value = size;
    try { localStorage.setItem(storageKey.value, String(size)); } catch {}
    return true;
  }

  return { pageSize, setPageSize };
}
