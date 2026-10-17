import { computed, inject, onBeforeUnmount, watch, ref, type InjectionKey, type Ref } from "vue";
import { api, ApiError, type Row } from "../api";
import type { ProjectPermissions } from "../domain/permissions";

type PermissionContext = { state: Ref<ProjectPermissions | null>; error: Ref<string>; refresh: () => Promise<void> };
export const permissionKey: InjectionKey<PermissionContext> = Symbol("project-permissions");

export function useProjectPermissions(options: { pid: Ref<number>; user: Ref<Row | null>; tick: Ref<number> }) {
  const state = ref<ProjectPermissions | null>(null), error = ref("");
  let serial = 0, currentProject = 0;
  function acceptSummary(summary: Omit<ProjectPermissions, "catalog">) {
    if (!options.user.value || !options.pid.value || typeof summary.can_edit !== "boolean" || !Array.isArray(summary.grants)) return;
    ++serial;
    state.value = { ...summary, catalog: state.value?.catalog || [] };
    error.value = "";
  }
  async function refresh() {
    const request = ++serial, pid = options.pid.value;
    if (pid !== currentProject || !options.user.value) state.value = null;
    currentProject = pid;
    if (!pid || !options.user.value) { error.value = ""; return; }
    try {
      const next = await api(`/projects/${pid}/permissions`);
      if (request !== serial) return;
      if (typeof next?.can_edit !== "boolean" || !Array.isArray(next?.grants) || !Array.isArray(next?.catalog)) throw new Error("权限接口返回异常");
      state.value = next;
      error.value = "";
    } catch (cause) {
      if (request !== serial) return;
      state.value = null;
      error.value = cause instanceof ApiError && cause.status === 404
        ? "当前后端尚不支持板卡和协议权限，请完成数据库升级并重启新版服务。"
        : cause instanceof ApiError && cause.status === 401
          ? "登录已过期，请重新登录后检查编辑权限。"
          : cause instanceof ApiError && cause.status === 403
            ? "你已无权访问此项目，请联系管理员确认成员权限。"
            : "无法读取板卡和协议权限，当前仅可查看；请重试检查。";
    }
  }
  watch([options.pid, options.user, options.tick], () => { void refresh(); }, { immediate: true });
  const permissionsChanged = (event: Event) => {
    if ((event as CustomEvent).detail?.pid === options.pid.value) void refresh();
  };
  window.addEventListener("project-permissions-changed", permissionsChanged);
  onBeforeUnmount(() => { ++serial; window.removeEventListener("project-permissions-changed", permissionsChanged); });
  return { state, error, refresh, acceptSummary, eligible: computed(() => !!state.value?.can_edit), canManage: computed(() => !!state.value?.can_manage_project) };
}

export function usePermissionContext() {
  return inject(permissionKey, { state: ref<ProjectPermissions | null>(null), error: ref(""), refresh: async () => {} });
}
