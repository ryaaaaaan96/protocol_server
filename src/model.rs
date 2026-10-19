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
