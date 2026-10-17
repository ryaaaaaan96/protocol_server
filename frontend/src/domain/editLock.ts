import type { ProjectPermissions } from "./permissions";

export type EditLockFailure = {
  kind:
    | "backend-version"
    | "session"
    | "permission"
    | "database"
    | "server"
    | "network"
    | "response"
    | "request";
  message: string;
  retryable: boolean;
};

export type ProjectLockState = {
  locked: boolean;
  owned: boolean;
  owner: { id: number; display_name: string; username: string } | null;
  expires_at: string | null;
  lease_seconds: number;
  permissions?: Omit<ProjectPermissions, "catalog">;
};

export function isProjectLockState(value: unknown): value is ProjectLockState {
  if (!value || typeof value !== "object") return false;
  const lock = value as Partial<ProjectLockState>;
  if (
    typeof lock.locked !== "boolean" ||
    typeof lock.owned !== "boolean" ||
    typeof lock.lease_seconds !== "number" ||
    lock.lease_seconds <= 0 ||
    (lock.owned && !lock.locked)
  )
    return false;
  return lock.locked
    ? !!lock.owner &&
        typeof lock.owner.id === "number" &&
        typeof lock.expires_at === "string" &&
        Number.isFinite(Date.parse(lock.expires_at))
    : lock.owner === null && lock.expires_at === null;
}

// This also classifies failures from reverse proxies which do not return JSON.
export function editLockFailure(cause: unknown): EditLockFailure {
  const problem = cause as {
    status?: number;
    message?: string;
    details?: { code?: string; error?: string };
  } | null;
  const status = problem?.status;
  const detail = problem?.details?.error || problem?.message || "";
  if (status === 401)
    return {
      kind: "session",
      message: "登录已过期，请重新登录后继续；未提交的修改尚未保存到服务器。",
      retryable: false,
    };
  if (status === 403)
    return {
      kind: "permission",
      message:
        "当前账号无权获取此项目的编辑权；请管理员检查项目、板卡和协议授权，调整后重试。草稿保留。",
      retryable: true,
    };
  if (status === 404 && /API 不存在|请求失败 \(404\)/.test(detail))
    return {
      kind: "backend-version",
      message:
        "当前后端没有编辑权接口，已切为只读；请管理员更新后端、完成数据库升级并重启服务，再重试检查。草稿保留。",
      retryable: true,
    };
  if (status === 404)
    return {
      kind: "request",
      message:
        "项目不存在或当前账号无法访问，已切为只读；请刷新项目列表或联系管理员检查授权。草稿保留。",
      retryable: true,
    };
  if (status && status >= 500)
    return /数据库/.test(detail)
      ? {
          kind: "database",
          message:
            "数据库无法读取编辑权，已切为只读；请管理员检查数据库连接、迁移及服务日志，恢复后重试。草稿保留。",
          retryable: true,
        }
      : {
          kind: "server",
          message: `编辑权服务暂时不可用（${status}），已切为只读；请稍后重试，持续出现请联系管理员。草稿保留。`,
          retryable: true,
        };
  if (problem?.details?.code === "INVALID_EDIT_LOCK_RESPONSE")
    return {
      kind: "response",
      message:
        "编辑权接口返回异常，已切为只读；请刷新后重试，持续出现请管理员检查后端版本和代理配置。草稿保留。",
      retryable: true,
    };
  if (status)
    return {
      kind: "request",
      message: `无法确认编辑权（${status}），已切为只读；请重试检查，持续出现请联系管理员。草稿保留。`,
      retryable: true,
    };
  return {
    kind: "network",
    message:
      "无法连接编辑权服务，已切为只读；请检查网络和服务是否启动，连接恢复后自动检查，也可手动重试。草稿保留。",
    retryable: true,
  };
}
