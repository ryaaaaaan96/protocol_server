use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

pub type Result<T> = std::result::Result<T, AppError>;
#[derive(Debug)]
pub struct AppError(pub StatusCode, pub String, pub Option<serde_json::Value>);
impl AppError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self(status, message.into(), None)
    }
    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }
    pub fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "没有此项目的操作权限")
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }
    pub fn revision_conflict(expected: i32, current: i32) -> Self {
        Self(
            StatusCode::CONFLICT,
            format!(
                "项目版本已从 {expected} 更新到 {current}，本次修改未保存，请基于最新数据重新修改"
            ),
            Some(
                json!({"code":"REVISION_CONFLICT","expected_revision":expected,"current_revision":current}),
            ),
        )
    }
    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "记录不存在或不可访问")
    }
}
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let mut body = self.2.unwrap_or_else(|| json!({}));
        body["error"] = json!(self.1);
        (self.0, Json(body)).into_response()
    }
}
impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        if let sqlx::Error::Database(ref d) = e {
            match d.code().as_deref() {
                Some("23505") => return Self::conflict("名称或编号已存在"),
                Some("23503") => return Self::bad("关联记录不存在或仍被引用"),
                Some("23514") | Some("23502") => {
                    return Self::bad("字段不满足数据库约束，请检查输入");
                }
                Some("42501") => return Self::forbidden(),
                _ => {}
            }
        }
        tracing::error!(error=%e,"database operation failed");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "数据库操作失败，请查看服务端日志",
        )
    }
}
impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::bad(e.to_string())
    }
}
