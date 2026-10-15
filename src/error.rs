use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

pub type Result<T> = std::result::Result<T, AppError>;
#[derive(Debug)]
pub struct AppError(pub StatusCode, pub String);
impl AppError {
    pub fn bad(message: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, message.into())
    }
    pub fn forbidden() -> Self {
        Self(StatusCode::FORBIDDEN, "没有此项目的操作权限".into())
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self(StatusCode::CONFLICT, message.into())
    }
    pub fn not_found() -> Self {
        Self(StatusCode::NOT_FOUND, "记录不存在或不可访问".into())
    }
}
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
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
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "数据库操作失败，请查看服务端日志".into(),
        )
    }
}
impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::bad(e.to_string())
    }
}
