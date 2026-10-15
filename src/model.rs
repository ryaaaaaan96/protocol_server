use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Point {
    pub scope: String,
    pub ordinal: i32,
    pub name: String,
    pub enum_name: String,
    pub signal_id: String,
    pub data_type: String,
    pub byte_length: i32,
    pub access: String,
    pub unit: String,
    pub scale: f64,
    pub address_mode: String,
    pub modbus_address: Option<i32>,
    pub upp_model: Option<i32>,
    pub upp_offset: Option<i32>,
    pub flags: String,
    pub poll_interval: i32,
    pub set_priority: i32,
    pub scan_priority: i32,
    pub callback: String,
    pub default_value: String,
    pub min_value: String,
    pub max_value: String,
    pub category: String,
    pub notes: String,
    pub source_sheet: String,
    pub source_row: Option<i32>,
    pub raw_json: Value,
}
impl Default for Point {
    fn default() -> Self {
        Self {
            scope: "LOCAL".into(),
            ordinal: 0,
            name: String::new(),
            enum_name: String::new(),
            signal_id: String::new(),
            data_type: "U16".into(),
            byte_length: 2,
            access: "RO".into(),
            unit: String::new(),
            scale: 1.,
            address_mode: "none".into(),
            modbus_address: None,
            upp_model: None,
            upp_offset: None,
            flags: "0".into(),
            poll_interval: 0,
            set_priority: 0,
            scan_priority: 0,
            callback: "NULL".into(),
            default_value: String::new(),
            min_value: String::new(),
            max_value: String::new(),
            category: String::new(),
            notes: String::new(),
            source_sheet: String::new(),
            source_row: None,
            raw_json: json!({}),
        }
    }
}
pub fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 160
        && s.chars()
            .enumerate()
            .all(|(i, c)| c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
}
pub fn snake(s: &str) -> String {
    let chars: Vec<char> = s.trim().chars().collect();
    let mut out = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if !c.is_ascii_alphanumeric() {
            if !out.ends_with('_') && !out.is_empty() {
                out.push('_');
            }
            continue;
        }
        if c.is_ascii_uppercase()
            && i > 0
            && (chars[i - 1].is_ascii_lowercase()
                || chars[i - 1].is_ascii_digit()
                || (chars[i - 1].is_ascii_uppercase()
                    && chars.get(i + 1).is_some_and(|c| c.is_ascii_lowercase())))
            && !out.ends_with('_')
        {
            out.push('_');
        }
        out.push(c.to_ascii_uppercase());
    }
    out.trim_matches('_').to_owned()
}
pub fn blank(s: &str) -> bool {
    matches!(s.trim(), "" | "/" | "※")
}
pub fn c_type(s: &str) -> &str {
    if s == "F32" { "FLOAT" } else { s }
}
impl Point {
    pub fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty() || self.name.len() > 900 {
            return Err(AppError::bad("测点名称不能为空且不能过长"));
        }
        if !["DSP", "LOCAL"].contains(&self.scope.as_str()) {
            return Err(AppError::bad("设备范围只能为 LOCAL 或 DSP"));
        }
        if !["U8", "U16", "S16", "U32", "S32", "F32", "STRING"].contains(&self.data_type.as_str()) {
            return Err(AppError::bad("不支持的数据类型"));
        }
        if !["RO", "RW", "WO", ""].contains(&self.access.as_str()) {
            return Err(AppError::bad("读写属性必须是 RO / RW / WO"));
        }
        if !self.enum_name.is_empty() && !identifier(&self.enum_name) {
            return Err(AppError::bad("枚举名必须是合法 C 标识符"));
        }
        if !blank(&self.signal_id)
            && self.signal_id != "0"
            && !(self.signal_id.parse::<u16>().is_ok() || identifier(&self.signal_id))
        {
            return Err(AppError::bad("信号 ID 应为 1～65535 或平台映射符号"));
        }
        if !flag_expression(&self.flags) {
            return Err(AppError::bad("配置参数仅支持整数、宏名和按位或表达式"));
        }
        if !identifier(&self.callback) {
            return Err(AppError::bad(
                "回调函数必须是合法 C 标识符（未配置时填 NULL）",
            ));
        }
        if self.byte_length < 1
            || self.byte_length > 65535
            || !(0..=255).contains(&self.poll_interval)
            || !(0..=3).contains(&self.set_priority)
            || !(0..=1).contains(&self.scan_priority)
            || self.ordinal < 0
        {
            return Err(AppError::bad("长度、排序或配置参数超出范围"));
        }
        if !self.scale.is_finite() || self.scale <= 0. {
            return Err(AppError::bad("精度必须为大于零的有限数值"));
        }
        if !["manual", "auto", "none"].contains(&self.address_mode.as_str()) {
            return Err(AppError::bad("未知地址模式"));
        }
        if self.address_mode == "manual" && self.modbus_address.is_none() {
            return Err(AppError::bad("手动模式需要寄存器地址"));
        }
        for v in [self.modbus_address, self.upp_offset] {
            if v.is_some_and(|v| !(0..=65535).contains(&v)) {
                return Err(AppError::bad("地址超出 16 位范围"));
            }
        }
        if self.upp_model.is_some_and(|v| !(1..=65535).contains(&v)) {
            return Err(AppError::bad("UPP 模型号超出范围"));
        }
        for v in [&self.default_value, &self.min_value, &self.max_value] {
            if v.len() > 4096 {
                return Err(AppError::bad("范围值过长"));
            }
            if self.data_type != "STRING"
                && !blank(v)
                && !v.parse::<f64>().is_ok_and(f64::is_finite)
                && !identifier(v)
            {
                return Err(AppError::bad(
                    "数值型测点的默认值和上下限必须是数字或 C 宏标识符",
                ));
            }
        }
        Ok(())
    }
}
pub fn flag_expression(s: &str) -> bool {
    if s.is_empty() || s.len() > 240 {
        return false;
    }
    fn spaces(bytes: &[u8], i: &mut usize) {
        while bytes.get(*i).is_some_and(u8::is_ascii_whitespace) {
            *i += 1;
        }
    }
    fn expression(bytes: &[u8], i: &mut usize) -> bool {
        if !atom(bytes, i) {
            return false;
        }
        loop {
            spaces(bytes, i);
            if bytes.get(*i) != Some(&b'|') {
                return true;
            }
            *i += 1;
            if !atom(bytes, i) {
                return false;
            }
        }
    }
    fn atom(bytes: &[u8], i: &mut usize) -> bool {
        spaces(bytes, i);
        if bytes.get(*i) == Some(&b'(') {
            *i += 1;
            if !expression(bytes, i) {
                return false;
            }
            spaces(bytes, i);
            if bytes.get(*i) != Some(&b')') {
                return false;
            }
            *i += 1;
            return true;
        }
        let start = *i;
        while bytes
            .get(*i)
            .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_')
        {
            *i += 1;
        }
        let token = std::str::from_utf8(&bytes[start..*i]).unwrap_or("");
        identifier(token)
            || token.parse::<u32>().is_ok()
            || token
                .strip_prefix("0x")
                .is_some_and(|s| u32::from_str_radix(s, 16).is_ok())
    }
    let mut i = 0;
    expression(s.as_bytes(), &mut i) && {
        spaces(s.as_bytes(), &mut i);
        i == s.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn c_flags_accept_only_constant_expressions() {
        for good in [
            "0",
            "17",
            "PARA_UNSTOR_UNSET",
            "(PARA_STOR_UNSET_RT | FLAG_READ_CALLBACK)",
            "0x20 | FLAG_PERSISTENCE",
        ] {
            assert!(flag_expression(good), "{good}");
        }
        for bad in [
            "A B",
            "5X",
            "call()",
            "1 || 2",
            "x; system(x)",
            "(A",
            "A |",
            "A)B",
        ] {
            assert!(!flag_expression(bad), "{bad}");
        }
    }
}
