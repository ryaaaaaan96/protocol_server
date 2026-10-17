import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type Ref,
} from "vue";
import { api, ApiError, type Row } from "../api";
import {
  editLockFailure,
  isProjectLockState,
  type EditLockFailure,
  type ProjectLockState,
} from "../domain/editLock";

export function useProjectEditLock(options: {
  pid: Ref<number>;
  user: Ref<Row | null>;
  eligible: Ref<boolean>;
  notify: (message: string, error?: boolean) => void;
  acquired: () => void;
}) {
  const state = ref<ProjectLockState | null>(null),
    pending = ref(false),
    checking = ref(false),
    failure = ref<EditLockFailure | null>(null);
  const now = ref(Date.now());
  const reliable = ref(false);
  let generation = 0,
    requestSerial = 0;
  let polling: number | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const alive = computed(
    () =>
      !!state.value?.locked &&
      Date.parse(state.value.expires_at || "") > now.value,
  );
  const owned = computed(
    () =>
      !!options.eligible.value &&
      reliable.value &&
      alive.value &&
      !!state.value?.owned,
  );
  const occupied = computed(() => alive.value && !state.value?.owned);
  const ownerName = computed(
    () =>
      state.value?.owner?.display_name ||
      state.value?.owner?.username ||
      "其他成员",
  );
  const message = computed(() => {
    if (failure.value) return failure.value.message;
    if (owned.value)
      return "你正在独占编辑 · 提交成功后自动释放，其他成员当前只能查看";
    if (occupied.value)
      return `${ownerName.value} 正在编辑此项目 · 你当前只能查看，待对方提交或结束编辑后可接续`;
    if (!state.value) return "正在检查项目编辑状态…";
    return options.eligible.value
      ? "当前为查看模式 · 点击开始编辑获取独占编辑权"
      : "你拥有只读权限，可以查看和复制数据";
  });
  function adopt(next: unknown) {
    if (!isProjectLockState(next))
      throw new ApiError("编辑权接口返回异常", 200, {
        code: "INVALID_EDIT_LOCK_RESPONSE",
      });
    state.value = next;
    now.value = Date.now();
    reliable.value = true;
    failure.value = null;
  }
  function fail(cause: unknown) {
    reliable.value = false;
    failure.value = editLockFailure(cause);
  }
  async function sync(renew = false) {
    if (polling != null || pending.value) return;
    const pid = options.pid.value,
      epoch = generation,
      serial = ++requestSerial;
    if (!pid || !options.user.value) return;
    polling = serial;
    checking.value = true;
    try {
      const next = await api(
        `/projects/${pid}/edit-lock${renew ? "/renew" : ""}`,
        renew ? "POST" : "GET",
        renew ? {} : undefined,
      );
      if (epoch === generation && serial === requestSerial) adopt(next);
    } catch (cause) {
      if (epoch !== generation || serial !== requestSerial) return;
      if (cause instanceof ApiError && isProjectLockState(cause.details.lock)) {
        adopt(cause.details.lock);
        options.notify(cause.message, true);
      } else {
        fail(cause);
      }
    } finally {
      if (polling === serial) {
        polling = null;
        checking.value = false;
      }
    }
  }
  async function acquire() {
    if (pending.value || !options.eligible.value) return;
    const pid = options.pid.value,
      epoch = generation,
      serial = ++requestSerial;
    pending.value = true;
    polling = null;
    checking.value = false;
    try {
      const next = await api(`/projects/${pid}/edit-lock/acquire`, "POST", {});
      if (epoch !== generation || serial !== requestSerial) return;
      adopt(next);
      options.acquired();
      options.notify("已获得独占编辑权，提交成功后自动释放。");
    } catch (cause) {
      if (epoch !== generation || serial !== requestSerial) return;
      if (cause instanceof ApiError && isProjectLockState(cause.details.lock))
        adopt(cause.details.lock);
      else fail(cause);
      options.notify(failure.value?.message || (cause as Error).message, true);
    } finally {
      if (epoch === generation) pending.value = false;
    }
  }
  async function release() {
    if (!state.value?.owned || !options.pid.value) return true;
    const pid = options.pid.value,
      epoch = generation,
      serial = ++requestSerial;
    pending.value = true;
    polling = null;
    checking.value = false;
    try {
      const next = await api(`/projects/${pid}/edit-lock/release`, "POST", {});
      if (epoch === generation && serial === requestSerial) adopt(next);
      return true;
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        ([401, 403].includes(cause.status) ||
          (cause.status === 423 && cause.details.lock?.owned === false))
      ) {
        if (epoch === generation && serial === requestSerial)
          adopt(
            isProjectLockState(cause.details.lock)
              ? cause.details.lock
              : {
                  locked: false,
                  owned: false,
                  owner: null,
                  expires_at: null,
                  lease_seconds: 120,
                },
          );
        return true;
      }
      if (epoch === generation && serial === requestSerial) {
        fail(cause);
        options.notify(failure.value!.message, true);
      }
      return false;
    } finally {
      if (epoch === generation) pending.value = false;
    }
  }
  function apiLockEvent(event: Event) {
    const detail = (event as CustomEvent).detail;
    if (detail.pid !== options.pid.value) return;
    ++requestSerial;
    polling = null;
    checking.value = false;
    if (detail.lock) {
      try {
        adopt(detail.lock);
      } catch (cause) {
        fail(cause);
      }
    } else {
      adopt({
        locked: false,
        owned: false,
        owner: null,
        expires_at: null,
        lease_seconds: 120,
      });
      void sync();
    }
  }
  watch(
    [options.pid, options.user],
    () => {
      generation++;
      requestSerial++;
      polling = null;
      checking.value = false;
      state.value = null;
      pending.value = false;
      reliable.value = false;
      failure.value = null;
      void sync();
    },
    { immediate: true },
  );
  onMounted(() => {
    window.addEventListener("project-edit-lock", apiLockEvent);
    timer = setInterval(() => {
      now.value = Date.now();
      if (!pending.value)
        void sync(
          !!state.value?.owned && alive.value && options.eligible.value,
        );
    }, 5000);
  });
  onBeforeUnmount(() => {
    generation++;
    clearInterval(timer);
    window.removeEventListener("project-edit-lock", apiLockEvent);
  });
  return {
    state,
    pending,
    checking,
    failure,
    owned,
    occupied,
    message,
    acquire,
    release,
    sync,
    retry: () => sync(),
  };
}
