<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

type MenuItem = {
  key: string;
  label: string;
  disabled?: boolean;
  separator?: boolean;
};

const props = defineProps<{
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
}>();
const emit = defineEmits<{
  select: [key: string];
  close: [];
}>();

const menu = ref<HTMLElement | null>(null);
const portalTarget = ref<HTMLElement | string>("body");
const position = ref({ left: props.x, top: props.y });
const ready = ref(false);
let trigger: HTMLElement | null = null;
let triggerBounds: DOMRect | null = null;
let closed = false;
let mounted = false;

function rememberTrigger() {
  const element = document.activeElement;
  if (element instanceof HTMLElement && !menu.value?.contains(element)) {
    trigger = element;
    triggerBounds = element.getBoundingClientRect();
    // Stay inside a modal's DOM subtree so its native inertness does not block us.
    portalTarget.value =
      element.closest<HTMLDialogElement>("dialog[open]") ?? "body";
  }
}

function restoreFocus() {
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
}

function close(restore = false) {
  if (closed) return;
  closed = true;
  if (restore) restoreFocus();
  emit("close");
}

function buttons() {
  return Array.from(
    menu.value?.querySelectorAll<HTMLButtonElement>(
      'button[role="menuitem"]:not(:disabled)',
    ) ?? [],
  );
}

async function placeAndFocus() {
  await nextTick();
  if (!mounted || !menu.value || closed) return;
  // A popover sits above the parent dialog and escapes its overflow clipping.
  // Older browsers still get a fixed menu teleported into the current dialog.
  if (
    typeof menu.value.showPopover === "function" &&
    !menu.value.matches(":popover-open")
  ) {
    menu.value.showPopover();
  }
  const bounds = menu.value.getBoundingClientRect();
  const margin = 8;
  position.value = {
    left: Math.max(
      margin,
      Math.min(props.x, window.innerWidth - bounds.width - margin),
    ),
    top: Math.max(
      margin,
      Math.min(props.y, window.innerHeight - bounds.height - margin),
    ),
  };
  ready.value = true;
  await nextTick();
  if (!mounted || closed) return;
  (buttons()[0] ?? menu.value)?.focus({ preventScroll: true });
}

function select(item: MenuItem) {
  if (item.disabled || closed) return;
  // Restore before selection so a dialog opened by the parent can take focus.
  closed = true;
  restoreFocus();
  emit("select", item.key);
  emit("close");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
    return;
  }
  if (event.key === "Tab") {
    // Let the browser continue tabbing from the original trigger.
    close(true);
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const items = buttons();
  if (!items.length) return;
  const current = items.findIndex((item) => item === document.activeElement);
  let index: number;
  if (event.key === "Home") index = 0;
  else if (event.key === "End") index = items.length - 1;
  else if (event.key === "ArrowDown") index = (current + 1) % items.length;
  else index = current <= 0 ? items.length - 1 : current - 1;
  items[index].focus({ preventScroll: true });
  items[index].scrollIntoView({ block: "nearest" });
}

function outside(event: Event) {
  if (event.target instanceof Node && menu.value?.contains(event.target))
    return;
  close();
}

function onScroll(event: Event) {
  // A tall menu may scroll internally; only viewport/ancestor scrolling closes it.
  if (event.target instanceof Node && menu.value?.contains(event.target))
    return;
  // Focusing a touch trigger may queue a scroll event before the menu mounts.
  // Only dismiss when scrolling actually moves its anchor afterwards.
  const bounds = trigger?.getBoundingClientRect();
  if (
    bounds &&
    triggerBounds &&
    Math.abs(bounds.left - triggerBounds.left) < 0.5 &&
    Math.abs(bounds.top - triggerBounds.top) < 0.5
  )
    return;
  close(true);
}

function onResize() {
  close(true);
}

function onWindowBlur() {
  close();
}

onMounted(() => {
  mounted = true;
  rememberTrigger();
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("contextmenu", outside, true);
  document.addEventListener("focusin", outside, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
  window.addEventListener("blur", onWindowBlur);
  void placeAndFocus();
});

watch(
  () => [props.x, props.y, props.label, props.items],
  () => {
    if (!mounted) return;
    rememberTrigger();
    closed = false;
    void placeAndFocus();
  },
);

onBeforeUnmount(() => {
  mounted = false;
  document.removeEventListener("pointerdown", outside, true);
  document.removeEventListener("contextmenu", outside, true);
  document.removeEventListener("focusin", outside, true);
  window.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onResize);
  window.removeEventListener("blur", onWindowBlur);
});
</script>

<template>
  <Teleport :to="portalTarget">
    <div
      ref="menu"
      class="context-menu"
      role="menu"
      popover="manual"
      :aria-label="label"
      tabindex="-1"
      :style="{
        left: `${position.left}px`,
        top: `${position.top}px`,
        visibility: ready ? 'visible' : 'hidden',
      }"
      @keydown="onKeydown"
      @contextmenu.prevent.stop
    >
      <div class="context-menu-label" aria-hidden="true">{{ label }}</div>
      <template v-for="item in items" :key="item.key">
        <div
          v-if="item.separator"
          class="context-menu-divider"
          role="separator"
        />
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          :disabled="item.disabled"
          @click="select(item)"
        >
          {{ item.label }}
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.context-menu {
  position: fixed;
  inset: auto;
  margin: 0;
  z-index: 2000;
  min-width: min(190px, calc(100vw - 16px));
  max-width: min(320px, calc(100vw - 16px));
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  padding: 5px;
  border: 1px solid var(--border, #e6ebf0);
  border-radius: 9px;
  background: #fff;
  box-shadow: 0 6px 24px #121e3024;
  outline: none;
}
.context-menu-label {
  padding: 6px 9px;
  color: #64748b;
  font-size: 12px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.context-menu button {
  display: block;
  width: 100%;
  min-height: 34px;
  padding: 7px 9px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #243247;
  text-align: left;
  font-size: 14px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.context-menu button:hover:not(:disabled),
.context-menu button:focus-visible {
  color: #0f766e;
  background: #edf8f6;
  outline: none;
}
.context-menu button:disabled {
  color: #94a3b8;
  opacity: 1;
}
.context-menu-divider {
  height: 1px;
  margin: 4px 3px;
  background: var(--border, #e6ebf0);
}
</style>
