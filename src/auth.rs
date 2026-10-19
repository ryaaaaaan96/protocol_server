use crate::{
    AppState,
    error::{AppError, Result},
};
use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{SaltString, rand_core::OsRng},
};
use axum::{
    Json,
    extract::{FromRequestParts, State},
    http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts},
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Clone, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub is_admin: bool,
}
impl FromRequestParts<AppState> for User {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self> {
        let token = parts
            .headers
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| {
                v.split(';')
                    .find_map(|part| part.trim().strip_prefix("protocol_session="))
            })
            .unwrap_or("");
        if token.len() != 64 {
            return Err(AppError::new(StatusCode::UNAUTHORIZED, "请先登录"));
        }
        let hash = hex::encode(Sha256::digest(token.as_bytes()));
        sqlx::query_as("SELECT u.id,u.username,u.display_name,u.is_admin FROM auth.sessions s JOIN auth.users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active")
            .bind(hash).fetch_optional(&state.pool.platform).await?.ok_or(AppError::new(StatusCode::UNAUTHORIZED,"登录已过期，请重新登录"))
    }
}
impl User {
    pub fn admin(&self) -> Result<()> {
        if self.is_admin {
            Ok(())
        } else {
            Err(AppError::forbidden())
        }
    }
}
pub async fn hash_password(password: String) -> Result<String> {
    if password.len() < 12 || password.len() > 256 {
        return Err(AppError::bad("密码长度应为 12～256 字节"));
    }
    tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|v| v.to_string())
            .map_err(|_| AppError::bad("密码处理失败"))
    })
    .await
    .map_err(|_| AppError::bad("密码处理失败"))?
}
#[derive(Deserialize)]
pub struct Login {
    username: String,
    password: String,
}
pub async fn login(
    State(state): State<AppState>,
    Json(input): Json<Login>,
) -> Result<(HeaderMap, Json<Value>)> {
    if input.username.len() > 80 || input.password.len() > 256 {
        return Err(AppError::bad("账号或密码格式不正确"));
    }
    let failures:i32=sqlx::query_scalar("INSERT INTO auth.login_attempts(username,failures) VALUES($1,1) ON CONFLICT(username) DO UPDATE SET failures=CASE WHEN login_attempts.updated_at<now()-interval '15 minutes' THEN 1 ELSE login_attempts.failures+1 END,updated_at=CASE WHEN login_attempts.updated_at<now()-interval '15 minutes' THEN now() ELSE login_attempts.updated_at END RETURNING failures")
        .bind(&input.username).fetch_one(&state.pool.platform).await?;
    if failures > 10 {
        return Err(AppError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "登录尝试过多，请 15 分钟后重试",
        ));
    }
    let record: Option<(i64, String)> =
        sqlx::query_as("SELECT id,password_hash FROM auth.users WHERE username=$1 AND active")
            .bind(&input.username)
            .fetch_optional(&state.pool.platform)
            .await?;
    let stored = record
        .as_ref()
        .map(|v| v.1.clone())
        .unwrap_or(state.dummy_hash.clone());
    let valid = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&stored).is_ok_and(|h| {
            Argon2::default()
                .verify_password(input.password.as_bytes(), &h)
                .is_ok()
        })
    })
    .await
    .unwrap_or(false);
    if !valid || record.is_none() {
        return Err(AppError::new(StatusCode::UNAUTHORIZED, "用户名或密码错误"));
    }
    let uid = record.unwrap().0;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    let mut tx = state.pool.platform.begin().await?;
    sqlx::query("DELETE FROM auth.login_attempts WHERE username=$1")
        .bind(input.username)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM auth.sessions WHERE expires_at<now()")
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO auth.sessions(token_hash,user_id) VALUES($1,$2)")
        .bind(hex::encode(Sha256::digest(token.as_bytes())))
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let user: User =
        sqlx::query_as("SELECT id,username,display_name,is_admin FROM auth.users WHERE id=$1")
            .bind(uid)
            .fetch_one(&state.pool.platform)
            .await?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "protocol_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200{}",
            if state.secure_cookie { "; Secure" } else { "" }
        ))
        .unwrap(),
    );
    Ok((headers, Json(json!(user))))
}
pub async fn me(user: User) -> Json<User> {
    Json(user)
}
pub async fn logout(
    State(state): State<AppState>,
    _user: User,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<Value>)> {
    if let Some(token) = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.split(';')
                .find_map(|p| p.trim().strip_prefix("protocol_session="))
        })
    {
        sqlx::query("DELETE FROM auth.sessions WHERE token_hash=$1")
            .bind(hex::encode(Sha256::digest(token.as_bytes())))
            .execute(&state.pool.platform)
            .await?;
    }
    let mut h = HeaderMap::new();
    h.insert(
        header::SET_COOKIE,
        HeaderValue::from_static("protocol_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"),
    );
    Ok((h, Json(json!({"ok":true}))))
}
