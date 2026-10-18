export type Row = Record<string, any>;
export class ApiError extends Error {
  constructor(message: string, public status: number, public details: Row) {
    super(message);
    this.name = "ApiError";
  }
  get revisionConflict() {
    return this.status === 409 && this.details.code === "REVISION_CONFLICT";
  }
}
export function revisionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.revisionConflict;
}
export async function api(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<any> {
  const form = body instanceof FormData;
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      "X-Requested-With": "protocol-studio",
      ...(!form && body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  });
  const data = await response
    .json()
    .catch(() => ({ error: `请求失败 (${response.status})` }));
  if (!response.ok) {
    if (response.status === 401 && path !== "/auth/login")
      window.dispatchEvent(new Event("session-expired"));
    const projectId = path.match(/^\/projects\/(\d+)\//)?.[1];
    if (projectId && response.status === 423)
      window.dispatchEvent(new CustomEvent("project-edit-lock", { detail: { pid: Number(projectId), lock: data.lock } }));
    if (projectId && response.status === 403 && data.code === "EDIT_SCOPE_DENIED")
      window.dispatchEvent(new CustomEvent("project-permissions-changed", { detail: { pid: Number(projectId) } }));
    throw new ApiError(data.error || `请求失败 (${response.status})`, response.status, data);
  }
  const committed = method === "POST" && path.match(/^\/projects\/(\d+)\/(?:changes\/\d+\/commit|imports\/\d+\/commit|releases)$/);
  if (committed)
    window.dispatchEvent(new CustomEvent("project-edit-lock", { detail: { pid: Number(committed[1]) } }));
  return data;
}
export const number = (v: unknown) => Number(v ?? 0).toLocaleString("zh-CN");
export const time = (v: string) =>
  v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "—";
export const roles: Record<string, string> = {
  admin: "管理员",
  engineer: "工程师",
  viewer: "只读成员",
};
export const actions: Record<string, string> = {
  "point.create": "新增测点",
  "point.update": "修改测点",
  "point.delete": "删除测点",
  "project.create": "创建项目",
  "project.folder_import": "导入项目文件夹",
  "import.commit": "导入点表",
  "release.create": "发布版本",
  "member.update": "调整成员权限",
  "mapping.update": "更新信号映射",
  "device.update": "修改设备地址段",
};
