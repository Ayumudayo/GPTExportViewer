use std::collections::{HashMap, HashSet};

use serde_json::Value;

const PUA_START: char = '\u{E200}';
const PUA_END: char = '\u{E201}';
const PUA_SEP: char = '\u{E202}';

#[derive(Clone)]
struct CitationEntry {
    label: String,
    url: String,
}

#[derive(Default)]
struct CitationMap {
    exact: HashMap<String, CitationEntry>,
    by_type_idx: HashMap<(String, u64), CitationEntry>,
}

impl CitationMap {
    fn from_metadata(metadata: &Value) -> Self {
        let mut map = Self::default();

        if let Some(bindings) = metadata
            .pointer("/model_dil_v2/appData/opGenui/modelDataBindings")
            .and_then(Value::as_object)
        {
            for (ref_key, item) in bindings {
                map.insert_value_ref(ref_key, item, None);
            }
        }

        if let Some(groups) = metadata
            .get("search_result_groups")
            .and_then(Value::as_array)
        {
            for group in groups {
                let domain = group.get("domain").and_then(Value::as_str);
                if let Some(entries) = group.get("entries").and_then(Value::as_array) {
                    for entry in entries {
                        if let Some(ref_id) = entry.get("ref_id") {
                            map.insert_ref_obj(ref_id, entry, domain);
                        }
                    }
                }
            }
        }

        if let Some(refs) = metadata
            .get("content_references")
            .and_then(Value::as_array)
        {
            for cr in refs {
                let items = cr
                    .get("items")
                    .and_then(Value::as_array)
                    .filter(|arr| !arr.is_empty())
                    .or_else(|| cr.get("fallback_items").and_then(Value::as_array));
                if let Some(items) = items {
                    for item in items {
                        if let Some(ref_list) = item.get("refs").and_then(Value::as_array) {
                            for ref_val in ref_list {
                                map.insert_ref_obj(ref_val, item, None);
                            }
                        }
                    }
                }
                if let Some(points) = cr.pointer("/data/points").and_then(Value::as_array) {
                    for point in points {
                        if let Some(ref_list) = point.get("refs").and_then(Value::as_array) {
                            for ref_val in ref_list {
                                map.insert_ref_obj(ref_val, point, None);
                            }
                        }
                    }
                }
            }
        }

        map
    }

    fn insert_ref_obj(&mut self, ref_val: &Value, item: &Value, fallback_domain: Option<&str>) {
        if let Some(key) = ref_val.as_str() {
            self.insert_value_ref(key, item, fallback_domain);
            return;
        }
        let Some(obj) = ref_val.as_object() else {
            return;
        };
        let turn_index = obj.get("turn_index").and_then(Value::as_u64);
        let ref_type = obj.get("ref_type").and_then(Value::as_str);
        let ref_index = obj.get("ref_index").and_then(Value::as_u64);
        let (Some(ref_type), Some(ref_index)) = (ref_type, ref_index) else {
            return;
        };
        if let Some(entry) = extract_citation_entry(item, fallback_domain) {
            if let Some(turn_index) = turn_index {
                self.exact
                    .entry(format!("turn{turn_index}{ref_type}{ref_index}"))
                    .or_insert_with(|| entry.clone());
            }
            self.by_type_idx
                .entry((ref_type.to_string(), ref_index))
                .or_insert(entry);
        }
    }

    fn insert_value_ref(&mut self, key: &str, item: &Value, fallback_domain: Option<&str>) {
        if key.is_empty() {
            return;
        }
        let Some(entry) = extract_citation_entry(item, fallback_domain) else {
            return;
        };
        self.exact
            .entry(key.to_string())
            .or_insert_with(|| entry.clone());
        if let Some((ref_type, ref_index)) = parse_turn_ref_parts(key) {
            self.by_type_idx
                .entry((ref_type, ref_index))
                .or_insert(entry);
        }
    }

    fn resolve(&self, token: &str) -> Option<&CitationEntry> {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            return None;
        }
        if let Some(entry) = self.exact.get(trimmed) {
            return Some(entry);
        }
        if let Some((ref_type, ref_index)) = parse_turn_ref_parts(trimmed) {
            return self.by_type_idx.get(&(ref_type, ref_index));
        }
        None
    }

    fn format_tokens(&self, tokens: &[&str]) -> String {
        let mut seen_urls = HashSet::new();
        let mut out = Vec::new();
        for token in tokens {
            let Some(entry) = self.resolve(token) else {
                continue;
            };
            if !seen_urls.insert(entry.url.clone()) {
                continue;
            }
            out.push(format!(
                "([{}]({}))",
                escape_md_label(&entry.label),
                entry.url
            ));
        }
        out.join(" ")
    }
}

fn extract_citation_entry(item: &Value, fallback_domain: Option<&str>) -> Option<CitationEntry> {
    let raw_url = item
        .get("url")
        .and_then(|value| {
            value
                .as_str()
                .or_else(|| value.get("uri").and_then(Value::as_str))
        })
        .map(str::trim)
        .filter(|url| is_safe_http_url(url))?;
    let url = clean_utm_source(raw_url);
    let label = item
        .get("attribution")
        .and_then(Value::as_str)
        .or_else(|| item.get("title").and_then(Value::as_str))
        .or_else(|| item.get("name").and_then(Value::as_str))
        .or(fallback_domain)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| url_host_or_full(&url));
    Some(CitationEntry { label, url })
}

fn clean_utm_source(url: &str) -> String {
    if let Some(stripped) = url.strip_suffix("?utm_source=chatgpt.com") {
        return stripped.to_string();
    }
    if url.contains("?utm_source=chatgpt.com&") {
        return url.replace("?utm_source=chatgpt.com&", "?");
    }
    if url.contains("&utm_source=chatgpt.com") {
        return url.replace("&utm_source=chatgpt.com", "");
    }
    url.to_string()
}

fn url_host_or_full(url: &str) -> String {
    let after_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    after_scheme
        .split(['/', '?', '#'])
        .next()
        .filter(|host| !host.is_empty())
        .unwrap_or(url)
        .to_string()
}

fn escape_md_label(label: &str) -> String {
    label.replace('[', "\\[").replace(']', "\\]")
}

fn is_safe_http_url(url: &str) -> bool {
    let trimmed = url.trim();
    trimmed.starts_with("https://") || trimmed.starts_with("http://")
}

fn parse_turn_ref_parts(token: &str) -> Option<(String, u64)> {
    let rest = token.strip_prefix("turn")?;
    let digit_end = rest
        .char_indices()
        .find(|(_, ch)| !ch.is_ascii_digit())
        .map(|(idx, _)| idx)?;
    if digit_end == 0 {
        return None;
    }
    let after_turn = &rest[digit_end..];
    let type_end = after_turn
        .char_indices()
        .find(|(_, ch)| !(ch.is_ascii_alphabetic() || *ch == '_'))
        .map(|(idx, _)| idx)?;
    if type_end == 0 {
        return None;
    }
    let ref_type = &after_turn[..type_end];
    let idx_str = &after_turn[type_end..];
    if idx_str.is_empty() || !idx_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let ref_index = idx_str.parse::<u64>().ok()?;
    Some((ref_type.to_string(), ref_index))
}

pub fn clean_message_text(raw: &str, metadata: &Value) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let is_widget_meta = metadata
        .get("content_references")
        .and_then(Value::as_array)
        .is_some_and(|refs| {
            refs.iter()
                .any(|item| item.get("type").and_then(Value::as_str) == Some("client_defined_widget"))
        });

    let needs_work = is_widget_meta
        || raw.contains(PUA_START)
        || raw.contains(PUA_END)
        || raw.contains(PUA_SEP)
        || contains_known_markup(raw);
    if !needs_work {
        return raw.to_string();
    }

    let citations = CitationMap::from_metadata(metadata);
    let pua_cleaned = clean_pua_tokens(raw, &citations);
    let segments = split_code_segments(&pua_cleaned);
    let mut code_slices: Vec<String> = Vec::new();
    let mut masked = String::with_capacity(pua_cleaned.len());
    let sentinel = pick_code_sentinel(&pua_cleaned);

    for (is_code, segment) in segments {
        if is_code {
            let idx = code_slices.len();
            code_slices.push(segment.to_string());
            masked.push_str(&format!("{sentinel}{idx}{sentinel}"));
        } else {
            masked.push_str(segment);
        }
    }

    let mut cleaned = clean_rich_inline_tags(&masked, &citations);
    let had_widget = is_widget_meta || has_widget_markup(&cleaned);
    if had_widget {
        cleaned = clean_widget_markup(&cleaned);
    }
    cleaned = normalize_whitespace(&cleaned);

    if code_slices.is_empty() {
        return cleaned;
    }

    let mut restored = cleaned;
    for (idx, code) in code_slices.into_iter().enumerate() {
        let token = format!("{sentinel}{idx}{sentinel}");
        let is_fenced = code.contains('\n');
        let replacement = if had_widget && code.starts_with([' ', '\t']) && is_fenced {
            dedent_fenced_code_block(&code)
        } else {
            code
        };
        if is_fenced {
            if let Some(pos) = restored.find(&token) {
                let line_start = restored[..pos].rfind('\n').map_or(0, |i| i + 1);
                if restored[line_start..pos].chars().all(|c| c == ' ' || c == '\t') {
                    let mut next = String::with_capacity(restored.len() + replacement.len());
                    next.push_str(&restored[..line_start]);
                    next.push_str(&replacement);
                    next.push_str(&restored[pos + token.len()..]);
                    restored = next;
                    continue;
                }
            }
        }
        restored = restored.replace(&token, &replacement);
    }
    restored
}

fn pick_code_sentinel(raw: &str) -> String {
    let mut candidate = "\u{FFFC}__GPTEXP_CODE_".to_string();
    while raw.contains(&candidate) {
        candidate.push('_');
    }
    candidate
}

fn dedent_fenced_code_block(block: &str) -> String {
    let first_line = block.lines().next().unwrap_or("");
    let indent_len = first_line.len() - first_line.trim_start_matches([' ', '\t']).len();
    if indent_len < 4 {
        return block.to_string();
    }
    let indent_prefix = &first_line[..indent_len];
    let mut out = String::with_capacity(block.len());
    for line in block.split_inclusive('\n') {
        if let Some(stripped) = line.strip_prefix(indent_prefix) {
            out.push_str(stripped);
        } else {
            let trimmed = line.trim_start_matches(' ');
            let spaces_removed = line.len() - trimmed.len();
            if spaces_removed <= indent_len {
                out.push_str(trimmed);
            } else {
                out.push_str(&line[indent_len..]);
            }
        }
    }
    out
}

fn contains_known_markup(text: &str) -> bool {
    const RICH_TAGS: &[&str] = &[
        "<Entity",
        "<Link",
        "<Cite",
        "<MapWidget",
        "<CodeCite",
        "<FileCite",
        "<MemoryCite",
        "<AsyncImage",
    ];
    RICH_TAGS.iter().any(|tag| text.contains(tag)) || has_widget_markup(text)
}

fn has_widget_markup(text: &str) -> bool {
    const WIDGET_TAGS: &[&str] = &[
        "<box",
        "<row",
        "<grid",
        "<list",
        "<table-row",
        "<table-cell",
        "<badge",
        "<divider",
        "<icon",
        "<radio-group",
        "<Chart",
        "<form",
        "<svg",
        "{#each",
    ];
    WIDGET_TAGS.iter().any(|tag| text.contains(tag))
}

fn split_code_segments(input: &str) -> Vec<(bool, &str)> {
    let mut segments = Vec::new();
    let mut prose_start = 0usize;
    let mut fence: Option<(char, usize, usize)> = None;
    let mut offset = 0usize;

    for raw_line in input.split_inclusive('\n') {
        let line_start = offset;
        offset += raw_line.len();
        let line = raw_line.trim_end_matches(['\r', '\n']);

        if let Some((marker_char, marker_len, fence_start)) = fence {
            if is_fence_close(line, marker_char, marker_len) {
                segments.push((true, &input[fence_start..offset]));
                fence = None;
                prose_start = offset;
            }
            continue;
        }

        if let Some((marker_char, marker_len)) = parse_fence_open(line) {
            if prose_start < line_start {
                push_inline_code_split(&input[prose_start..line_start], &mut segments);
            }
            fence = Some((marker_char, marker_len, line_start));
        }
    }

    if let Some((_, _, fence_start)) = fence {
        segments.push((true, &input[fence_start..]));
    } else if prose_start < input.len() {
        push_inline_code_split(&input[prose_start..], &mut segments);
    }

    segments
}

fn parse_fence_open(line: &str) -> Option<(char, usize)> {
    let trimmed = line.trim_start_matches([' ', '\t']);
    let first = trimmed.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let marker_len = trimmed.chars().take_while(|&ch| ch == first).count();
    if marker_len < 3 {
        return None;
    }
    let info = &trimmed[marker_len..];
    if first == '`' && info.contains('`') {
        return None;
    }
    Some((first, marker_len))
}

fn is_fence_close(line: &str, marker_char: char, marker_len: usize) -> bool {
    let trimmed = line.trim_start_matches([' ', '\t']);
    let close_len = trimmed.chars().take_while(|&ch| ch == marker_char).count();
    if close_len < marker_len {
        return false;
    }
    trimmed[close_len..].trim().is_empty()
}

fn push_inline_code_split<'a>(prose: &'a str, segments: &mut Vec<(bool, &'a str)>) {
    let mut cursor = 0usize;
    let bytes = prose.as_bytes();
    while cursor < prose.len() {
        let Some(rel_open) = prose[cursor..].find('`') else {
            segments.push((false, &prose[cursor..]));
            break;
        };
        let open_pos = cursor + rel_open;
        let tick_len = bytes[open_pos..].iter().take_while(|&&b| b == b'`').count();
        let search_from = open_pos + tick_len;

        if let Some(close_end) = find_matching_backticks(prose, search_from, tick_len) {
            if open_pos > cursor {
                segments.push((false, &prose[cursor..open_pos]));
            }
            segments.push((true, &prose[open_pos..close_end]));
            cursor = close_end;
        } else {
            segments.push((false, &prose[cursor..search_from]));
            cursor = search_from;
        }
    }
}

fn find_matching_backticks(prose: &str, from: usize, tick_len: usize) -> Option<usize> {
    let bytes = prose.as_bytes();
    let mut idx = from;
    while idx < prose.len() {
        if bytes[idx] == b'\n' {
            return None;
        }
        if bytes[idx] == b'`' {
            let run = bytes[idx..].iter().take_while(|&&b| b == b'`').count();
            if run == tick_len {
                return Some(idx + run);
            }
            idx += run;
            continue;
        }
        idx += 1;
    }
    None
}

fn clean_pua_tokens(text: &str, citations: &CitationMap) -> String {
    if !text.contains(PUA_START) && !text.contains(PUA_END) && !text.contains(PUA_SEP) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;

    while let Some(rel_start) = text[cursor..].find(PUA_START) {
        let start = cursor + rel_start;
        out.push_str(&text[cursor..start]);
        let after_start = start + PUA_START.len_utf8();

        if let Some(rel_end) = text[after_start..].find(PUA_END) {
            let inner = &text[after_start..after_start + rel_end];
            let replacement = render_pua_payload(inner, citations);
            if !replacement.is_empty() {
                let line_start = out.rfind('\n').map_or(0, |i| i + 1);
                let line_prefix = out[line_start..].trim();
                if line_prefix.len() >= 3
                    && (line_prefix.bytes().all(|b| b == b'`')
                        || line_prefix.bytes().all(|b| b == b'~'))
                {
                    out.push_str("\n\n");
                } else if !out.is_empty()
                    && !out.ends_with(|ch: char| ch.is_whitespace() || matches!(ch, '(' | '[' | '{'))
                {
                    out.push(' ');
                }
            }
            out.push_str(&replacement);
            cursor = after_start + rel_end + PUA_END.len_utf8();
        } else {
            cursor = after_start;
        }
    }
    out.push_str(&text[cursor..]);
    out.replace([PUA_START, PUA_END, PUA_SEP], "")
}

fn render_pua_payload(inner: &str, citations: &CitationMap) -> String {
    let mut parts = inner.split(PUA_SEP);
    let tag = parts.next().unwrap_or("").trim();
    let rest: Vec<&str> = parts.collect();

    match tag {
        "memcite" | "filecite" | "image_group" => String::new(),
        "entity" => rest
            .first()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|val| val.as_array().and_then(|arr| arr.get(1)?.as_str()).map(str::to_string))
            .unwrap_or_default(),
        "url" => {
            let label = rest.first().copied().unwrap_or("").trim();
            let target = rest.get(1).copied().unwrap_or("").trim();
            if is_safe_http_url(target) {
                let clean = clean_utm_source(target);
                let display = if label.is_empty() { clean.as_str() } else { label };
                format!("[{}]({})", escape_md_label(display), clean)
            } else if let Some(entry) = citations.resolve(target) {
                let display = if label.is_empty() { entry.label.as_str() } else { label };
                format!("[{}]({})", escape_md_label(display), entry.url)
            } else {
                label.to_string()
            }
        }
        "cite" => citations.format_tokens(&rest),
        "genui" => {
            let Some(raw_json) = rest.first() else {
                return String::new();
            };
            let Ok(parsed) = serde_json::from_str::<Value>(raw_json) else {
                return String::new();
            };
            let mut refs: Vec<&str> = Vec::new();
            if let Some(single) = parsed.pointer("/citation/ref").and_then(Value::as_str) {
                refs.push(single);
            }
            if let Some(multi) = parsed.pointer("/citation/refs").and_then(Value::as_array) {
                for item in multi.iter().filter_map(Value::as_str) {
                    refs.push(item);
                }
            }
            citations.format_tokens(&refs)
        }
        _ => String::new(),
    }
}

#[derive(Clone, Debug)]
enum AttrValue {
    Str(String),
    Expr(String),
}

impl AttrValue {
    fn as_str(&self) -> &str {
        match self {
            AttrValue::Str(s) | AttrValue::Expr(s) => s.as_str(),
        }
    }
}

fn find_tag_end(text: &str, after_name: usize) -> Option<(usize, bool)> {
    let mut brace_depth = 0usize;
    let mut quote: Option<char> = None;
    let mut escape = false;
    let mut prev_slash = false;

    for (rel_idx, ch) in text[after_name..].char_indices() {
        let abs_idx = after_name + rel_idx;
        if let Some(q) = quote {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == q {
                quote = None;
            }
            prev_slash = false;
            continue;
        }
        match ch {
            '"' | '\'' => {
                quote = Some(ch);
                prev_slash = false;
            }
            '{' => {
                brace_depth += 1;
                prev_slash = false;
            }
            '}' => {
                brace_depth = brace_depth.saturating_sub(1);
                prev_slash = false;
            }
            '/' if brace_depth == 0 => {
                prev_slash = true;
            }
            '>' if brace_depth == 0 => {
                return Some((abs_idx + 1, prev_slash));
            }
            _ => {
                if !ch.is_whitespace() {
                    prev_slash = false;
                }
            }
        }
    }
    None
}

fn parse_tag_attrs(attr_slice: &str) -> Vec<(String, AttrValue)> {
    let mut attrs = Vec::new();
    let mut idx = 0usize;
    let len = attr_slice.len();

    while idx < len {
        while let Some(ch) = attr_slice[idx..].chars().next() {
            if ch.is_whitespace() || ch == '/' {
                idx += ch.len_utf8();
            } else {
                break;
            }
        }
        if idx >= len {
            break;
        }
        let name_start = idx;
        while let Some(ch) = attr_slice[idx..].chars().next() {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | ':') {
                idx += ch.len_utf8();
            } else {
                break;
            }
        }
        if idx == name_start {
            if let Some(ch) = attr_slice[idx..].chars().next() {
                idx += ch.len_utf8();
            }
            continue;
        }
        let name = attr_slice[name_start..idx].to_string();
        while let Some(ch) = attr_slice[idx..].chars().next() {
            if ch.is_whitespace() {
                idx += ch.len_utf8();
            } else {
                break;
            }
        }
        if !attr_slice[idx..].starts_with('=') {
            attrs.push((name, AttrValue::Str("true".to_string())));
            continue;
        }
        idx += 1;
        while let Some(ch) = attr_slice[idx..].chars().next() {
            if ch.is_whitespace() {
                idx += ch.len_utf8();
            } else {
                break;
            }
        }
        let Some(first) = attr_slice[idx..].chars().next() else {
            break;
        };
        if first == '"' || first == '\'' {
            idx += first.len_utf8();
            let val_start = idx;
            let mut val = String::new();
            let mut esc = false;
            for (rel, ch) in attr_slice[val_start..].char_indices() {
                if esc {
                    val.push(ch);
                    esc = false;
                } else if ch == '\\' {
                    esc = true;
                } else if ch == first {
                    idx = val_start + rel + ch.len_utf8();
                    break;
                } else {
                    val.push(ch);
                    idx = val_start + rel + ch.len_utf8();
                }
            }
            attrs.push((name, AttrValue::Str(val)));
        } else if first == '{' {
            idx += 1;
            let val_start = idx;
            let mut depth = 1usize;
            let mut q: Option<char> = None;
            let mut esc = false;
            let mut end_idx = attr_slice.len();
            for (rel, ch) in attr_slice[val_start..].char_indices() {
                if let Some(quote_char) = q {
                    if esc {
                        esc = false;
                    } else if ch == '\\' {
                        esc = true;
                    } else if ch == quote_char {
                        q = None;
                    }
                    continue;
                }
                match ch {
                    '"' | '\'' => q = Some(ch),
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            end_idx = val_start + rel;
                            idx = end_idx + 1;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            attrs.push((name, AttrValue::Expr(attr_slice[val_start..end_idx].to_string())));
        }
    }
    attrs
}

fn attr_get<'a>(attrs: &'a [(String, AttrValue)], key: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

fn find_closing_tag_range(text: &str, open_end: usize, tag_name: &str) -> Option<(usize, usize)> {
    let close_needle = format!("</{tag_name}>");
    let open_prefix = format!("<{tag_name}");
    let mut depth = 1usize;
    let mut pos = open_end;

    while pos < text.len() {
        let next_open = text[pos..].find(&open_prefix).map(|r| pos + r);
        let next_close = text[pos..].find(&close_needle).map(|r| pos + r);
        match (next_open, next_close) {
            (_, None) => return None,
            (Some(o), Some(c)) if o < c => {
                let after_name = o + open_prefix.len();
                let next_ch = text[after_name..].chars().next();
                if next_ch.is_some_and(|ch| ch.is_whitespace() || ch == '>' || ch == '/') {
                    if let Some((tag_end, self_closing)) = find_tag_end(text, after_name) {
                        if !self_closing {
                            depth += 1;
                        }
                        pos = tag_end;
                        continue;
                    }
                }
                pos = after_name;
            }
            (_, Some(c)) => {
                depth -= 1;
                let close_end = c + close_needle.len();
                if depth == 0 {
                    return Some((c, close_end));
                }
                pos = close_end;
            }
        }
    }
    None
}

fn clean_rich_inline_tags(text: &str, citations: &CitationMap) -> String {
    const TAGS: &[&str] = &[
        "Entity",
        "Cite",
        "Link",
        "MapWidgetV2",
        "MapWidget",
        "CodeCite",
        "FileCite",
        "MemoryCite",
        "AsyncImageGroup",
        "AsyncImage",
    ];
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;

    while cursor < text.len() {
        let Some(rel_lt) = text[cursor..].find('<') else {
            out.push_str(&text[cursor..]);
            break;
        };
        let lt_pos = cursor + rel_lt;
        out.push_str(&text[cursor..lt_pos]);

        let rest = &text[lt_pos + 1..];
        let matched_tag = TAGS.iter().find(|&&tag| {
            rest.starts_with(tag)
                && rest[tag.len()..]
                    .chars()
                    .next()
                    .is_some_and(|ch| ch.is_whitespace() || ch == '>' || ch == '/')
        });

        let Some(&tag_name) = matched_tag else {
            out.push('<');
            cursor = lt_pos + 1;
            continue;
        };

        let after_name = lt_pos + 1 + tag_name.len();
        let Some((tag_end, self_closing)) = find_tag_end(text, after_name) else {
            out.push('<');
            cursor = lt_pos + 1;
            continue;
        };

        let raw_attrs = text[after_name..tag_end - if self_closing { 2 } else { 1 }].trim();
        let attrs = parse_tag_attrs(raw_attrs);

        let (inner, next_cursor) = if self_closing {
            ("", tag_end)
        } else if let Some((close_start, close_end)) =
            find_closing_tag_range(text, tag_end, tag_name)
        {
            (&text[tag_end..close_start], close_end)
        } else {
            ("", tag_end)
        };

        match tag_name {
            "Entity" => {
                let value = attr_get(&attrs, "value")
                    .or_else(|| attr_get(&attrs, "name"))
                    .unwrap_or("")
                    .trim();
                out.push_str(value);
            }
            "Cite" => {
                let tokens = collect_turn_refs(&attrs);
                let refs: Vec<&str> = tokens.iter().map(String::as_str).collect();
                let formatted = citations.format_tokens(&refs);
                if !formatted.is_empty()
                    && !out.is_empty()
                    && !out.ends_with(|ch: char| ch.is_whitespace() || matches!(ch, '(' | '['))
                {
                    out.push(' ');
                }
                out.push_str(&formatted);
            }
            "Link" => {
                let url = attr_get(&attrs, "url").unwrap_or("").trim();
                let inner_clean = clean_rich_inline_tags(inner, citations);
                let label = if !inner_clean.trim().is_empty() {
                    inner_clean.trim().to_string()
                } else {
                    attr_get(&attrs, "title")
                        .or_else(|| attr_get(&attrs, "label"))
                        .unwrap_or(url)
                        .trim()
                        .to_string()
                };
                if is_safe_http_url(url) {
                    let clean = clean_utm_source(url);
                    let display = if label.is_empty() { clean.clone() } else { label };
                    out.push_str(&format!("[{}]({})", escape_md_label(&display), clean));
                } else {
                    out.push_str(&label);
                }
            }
            "MapWidgetV2" | "MapWidget" => {
                if let Some(points_raw) = attr_get(&attrs, "points") {
                    if let Ok(Value::Array(points)) = serde_json::from_str::<Value>(points_raw) {
                        let lines: Vec<String> = points
                            .iter()
                            .filter_map(|point| {
                                let name = point
                                    .get("name")
                                    .or_else(|| point.get("title"))
                                    .and_then(Value::as_str)?
                                    .trim();
                                if name.is_empty() {
                                    return None;
                                }
                                let address = point
                                    .get("address")
                                    .and_then(Value::as_str)
                                    .map(str::trim)
                                    .filter(|addr| !addr.is_empty());
                                Some(match address {
                                    Some(addr) => format!("- **{name}** — {addr}"),
                                    None => format!("- **{name}**"),
                                })
                            })
                            .collect();
                        if !lines.is_empty() {
                            if !out.is_empty() && !out.ends_with("\n\n") {
                                out.push_str(if out.ends_with('\n') { "\n" } else { "\n\n" });
                            }
                            out.push_str(&lines.join("\n"));
                            out.push('\n');
                        }
                    }
                }
            }
            _ => {}
        }

        cursor = next_cursor;
    }

    out
}

fn collect_turn_refs(attrs: &[(String, AttrValue)]) -> Vec<String> {
    let mut found = Vec::new();
    for (key, value) in attrs {
        if key != "ref" && key != "refs" {
            continue;
        }
        let raw = value.as_str();
        if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) {
            for item in items.iter().filter_map(Value::as_str) {
                found.push(item.to_string());
            }
            continue;
        }
        let mut idx = 0usize;
        while let Some(rel) = raw[idx..].find("turn") {
            let start = idx + rel;
            let tail = &raw[start..];
            let token: String = tail
                .chars()
                .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
                .collect();
            if parse_turn_ref_parts(&token).is_some() {
                found.push(token.clone());
            }
            idx = start + token.len().max(4);
        }
    }
    found
}

fn clean_widget_markup(text: &str) -> String {
    let expanded = expand_each_blocks(text, 0);
    let no_if = strip_svelte_control_blocks(&expanded);
    let no_svg = replace_svg_blocks(&no_if);
    let no_config = strip_named_blocks(&no_svg, &["config", "Chart"]);
    let with_dividers = replace_divider_tags(&no_config);
    let with_icons = replace_icon_tags(&with_dividers);
    let with_inline_semantic = replace_inline_semantic_tags(&with_icons);
    let with_lists = replace_list_blocks(&with_inline_semantic);
    let with_radios = replace_radio_groups(&with_lists);
    let with_tables = replace_widget_tables(&with_radios);
    let with_rows = replace_row_blocks(&with_tables);
    unwrap_container_tags(&with_rows)
}

fn expand_each_blocks(input: &str, depth: usize) -> String {
    if depth >= 4 || !input.contains("{#each ") {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;

    while let Some(rel_start) = input[cursor..].find("{#each ") {
        let start = cursor + rel_start;
        out.push_str(&input[cursor..start]);

        let Some((header_end, body_start)) = find_directive_end(input, start) else {
            out.push_str(&input[start..]);
            return out;
        };
        let header = input[start + 7..header_end].trim();
        let Some((body_end, block_end)) = find_matching_each_end(input, body_start) else {
            out.push_str(&input[start..]);
            return out;
        };

        let body = &input[body_start..body_end];
        if let Some((expr, item_var, index_var)) = parse_each_header(header) {
            if let Some(items) = parse_js_array_literal(expr) {
                for (idx, item) in items.iter().enumerate() {
                    let mut rendered = body.to_string();
                    rendered = apply_each_item(&rendered, item_var, index_var, idx, item);
                    rendered = expand_each_blocks(&rendered, depth + 1);
                    out.push_str(&rendered);
                }
                cursor = block_end;
                continue;
            }
        }
        out.push_str(&expand_each_blocks(body, depth + 1));
        cursor = block_end;
    }

    out.push_str(&input[cursor..]);
    out
}

fn find_directive_end(text: &str, open_brace: usize) -> Option<(usize, usize)> {
    let mut depth = 0usize;
    let mut quote: Option<char> = None;
    let mut escape = false;
    for (rel, ch) in text[open_brace..].char_indices() {
        let abs = open_brace + rel;
        if let Some(q) = quote {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == q {
                quote = None;
            }
            continue;
        }
        match ch {
            '"' | '\'' => quote = Some(ch),
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some((abs, abs + 1));
                }
            }
            _ => {}
        }
    }
    None
}

fn find_matching_each_end(text: &str, body_start: usize) -> Option<(usize, usize)> {
    let mut depth = 1usize;
    let mut pos = body_start;
    while pos < text.len() {
        let next_open = text[pos..].find("{#each ").map(|r| pos + r);
        let next_close = text[pos..].find("{/each}").map(|r| pos + r);
        match (next_open, next_close) {
            (_, None) => return None,
            (Some(o), Some(c)) if o < c => {
                depth += 1;
                pos = o + 7;
            }
            (_, Some(c)) => {
                depth -= 1;
                if depth == 0 {
                    return Some((c, c + 7));
                }
                pos = c + 7;
            }
        }
    }
    None
}

fn parse_each_header(header: &str) -> Option<(&str, &str, Option<&str>)> {
    let as_pos = header.rfind(" as ")?;
    let expr = header[..as_pos].trim();
    let binding = header[as_pos + 4..].trim();
    let (item_var, index_var) = if let Some((a, b)) = binding.split_once(',') {
        (a.trim(), Some(b.trim()))
    } else {
        (binding, None)
    };
    if item_var.is_empty() {
        return None;
    }
    Some((expr, item_var, index_var))
}

#[derive(Clone, Debug)]
enum JsVal {
    Str(String),
    Num(String),
    Bool(bool),
    Obj(HashMap<String, JsVal>),
}

impl JsVal {
    fn as_display(&self) -> String {
        match self {
            JsVal::Str(s) => s.clone(),
            JsVal::Num(raw) => raw.clone(),
            JsVal::Bool(b) => b.to_string(),
            JsVal::Obj(_) => String::new(),
        }
    }
}

fn parse_js_array_literal(input: &str) -> Option<Vec<JsVal>> {
    let trimmed = input.trim();
    if !trimmed.starts_with('[') || !trimmed.ends_with(']') {
        return None;
    }
    let bytes = trimmed.as_bytes();
    let mut pos = 1usize;
    let mut items = Vec::new();
    skip_js_ws(trimmed, &mut pos);
    while pos < bytes.len() && bytes[pos] != b']' {
        let val = parse_js_value(trimmed, &mut pos)?;
        items.push(val);
        skip_js_ws(trimmed, &mut pos);
        if pos < bytes.len() && bytes[pos] == b',' {
            pos += 1;
            skip_js_ws(trimmed, &mut pos);
        } else {
            break;
        }
    }
    skip_js_ws(trimmed, &mut pos);
    (pos < bytes.len() && bytes[pos] == b']').then_some(items)
}

fn parse_js_value(s: &str, pos: &mut usize) -> Option<JsVal> {
    skip_js_ws(s, pos);
    let rest = s.get(*pos..)?;
    if rest.starts_with('{') {
        *pos += 1;
        let mut map = HashMap::new();
        skip_js_ws(s, pos);
        while *pos < s.len() && !s[*pos..].starts_with('}') {
            let key = if s[*pos..].starts_with('"') || s[*pos..].starts_with('\'') {
                parse_js_string(s, pos)?
            } else {
                let start = *pos;
                while let Some(ch) = s[*pos..].chars().next() {
                    if ch.is_ascii_alphanumeric() || ch == '_' || ch == '$' {
                        *pos += ch.len_utf8();
                    } else {
                        break;
                    }
                }
                if *pos == start {
                    return None;
                }
                s[start..*pos].to_string()
            };
            skip_js_ws(s, pos);
            if !s[*pos..].starts_with(':') {
                return None;
            }
            *pos += 1;
            let val = parse_js_value(s, pos)?;
            map.insert(key, val);
            skip_js_ws(s, pos);
            if s[*pos..].starts_with(',') {
                *pos += 1;
                skip_js_ws(s, pos);
            } else {
                break;
            }
        }
        if !s[*pos..].starts_with('}') {
            return None;
        }
        *pos += 1;
        return Some(JsVal::Obj(map));
    }
    if rest.starts_with('"') || rest.starts_with('\'') {
        return Some(JsVal::Str(parse_js_string(s, pos)?));
    }
    if rest.starts_with("true") && !rest[4..].starts_with(|c: char| c.is_ascii_alphanumeric()) {
        *pos += 4;
        return Some(JsVal::Bool(true));
    }
    if rest.starts_with("false") && !rest[5..].starts_with(|c: char| c.is_ascii_alphanumeric()) {
        *pos += 5;
        return Some(JsVal::Bool(false));
    }
    let start = *pos;
    while let Some(ch) = s[*pos..].chars().next() {
        if ch.is_ascii_digit() || matches!(ch, '.' | '-' | '+') {
            *pos += ch.len_utf8();
        } else {
            break;
        }
    }
    if *pos > start {
        let raw = s[start..*pos].to_string();
        if raw.parse::<f64>().is_ok() {
            return Some(JsVal::Num(raw));
        }
        return None;
    }
    None
}

fn parse_js_string(s: &str, pos: &mut usize) -> Option<String> {
    let quote = s[*pos..].chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    *pos += 1;
    let mut out = String::new();
    let mut esc = false;
    for (rel, ch) in s[*pos..].char_indices() {
        if esc {
            match ch {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'r' => out.push('\r'),
                other => out.push(other),
            }
            esc = false;
        } else if ch == '\\' {
            esc = true;
        } else if ch == quote {
            *pos += rel + 1;
            return Some(out);
        } else {
            out.push(ch);
        }
    }
    None
}

fn skip_js_ws(s: &str, pos: &mut usize) {
    while let Some(ch) = s[*pos..].chars().next() {
        if ch.is_whitespace() {
            *pos += ch.len_utf8();
        } else {
            break;
        }
    }
}

fn apply_each_item(
    body: &str,
    item_var: &str,
    index_var: Option<&str>,
    idx: usize,
    item: &JsVal,
) -> String {
    let mut out = body.to_string();
    if let JsVal::Obj(map) = item {
        for (key, val) in map {
            let needle = format!("{{{item_var}.{key}}}");
            out = out.replace(&needle, &val.as_display());
        }
    } else {
        let needle = format!("{{{item_var}}}");
        out = out.replace(&needle, &item.as_display());
    }
    if let Some(index_var) = index_var {
        let needle = format!("{{{index_var}}}");
        out = out.replace(&needle, &idx.to_string());
        out = eval_indexed_if_blocks(&out, index_var, idx);
    }
    out
}

fn eval_indexed_if_blocks(text: &str, index_var: &str, idx: usize) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;

    while let Some(rel_start) = text[cursor..].find("{#if ") {
        let start = cursor + rel_start;
        out.push_str(&text[cursor..start]);
        let Some((header_end, body_start)) = find_directive_end(text, start) else {
            out.push_str(&text[start..]);
            return out;
        };
        let cond = text[start + 5..header_end].trim();
        let Some((body_end, block_end)) = find_matching_if_end(text, body_start) else {
            out.push_str(&text[start..]);
            return out;
        };
        let block_body = &text[body_start..body_end];
        if let Some(selected) = resolve_indexed_if_branch(cond, block_body, index_var, idx) {
            out.push_str(selected);
        } else {
            out.push_str(&text[start..block_end]);
        }
        cursor = block_end;
    }
    out.push_str(&text[cursor..]);
    out
}

fn find_matching_if_end(text: &str, body_start: usize) -> Option<(usize, usize)> {
    let mut depth = 1usize;
    let mut pos = body_start;
    while pos < text.len() {
        let next_open = text[pos..].find("{#if ").map(|r| pos + r);
        let next_close = text[pos..].find("{/if}").map(|r| pos + r);
        match (next_open, next_close) {
            (_, None) => return None,
            (Some(o), Some(c)) if o < c => {
                depth += 1;
                pos = o + 5;
            }
            (_, Some(c)) => {
                depth -= 1;
                if depth == 0 {
                    return Some((c, c + 5));
                }
                pos = c + 5;
            }
        }
    }
    None
}

fn resolve_indexed_if_branch<'a>(
    first_cond: &str,
    body: &'a str,
    index_var: &str,
    idx: usize,
) -> Option<&'a str> {
    let mut branches: Vec<(Option<&str>, &str)> = Vec::new();
    let mut cur_cond: Option<&str> = Some(first_cond);
    let mut seg_start = 0usize;
    let mut pos = 0usize;
    let mut nested = 0usize;

    while pos < body.len() {
        if body[pos..].starts_with("{#if ") {
            nested += 1;
            pos += 5;
            continue;
        }
        if body[pos..].starts_with("{/if}") {
            nested = nested.saturating_sub(1);
            pos += 5;
            continue;
        }
        if nested == 0 && body[pos..].starts_with("{:else") {
            if let Some((dir_end, after_dir)) = find_directive_end(body, pos) {
                branches.push((cur_cond, &body[seg_start..pos]));
                let directive = body[pos + 6..dir_end].trim();
                cur_cond = directive.strip_prefix("if ").map(str::trim);
                seg_start = after_dir;
                pos = after_dir;
                continue;
            }
        }
        if let Some(ch) = body[pos..].chars().next() {
            pos += ch.len_utf8();
        } else {
            break;
        }
    }
    branches.push((cur_cond, &body[seg_start..]));

    for (cond_opt, branch_body) in branches {
        match cond_opt {
            None => return Some(branch_body),
            Some(cond) => {
                if eval_simple_index_condition(cond, index_var, idx)? {
                    return Some(branch_body);
                }
            }
        }
    }
    Some("")
}

fn eval_simple_index_condition(cond: &str, index_var: &str, idx: usize) -> Option<bool> {
    let compact: String = cond.chars().filter(|c| !c.is_whitespace()).collect();
    if let Some(rhs) = compact.strip_prefix(&format!("{index_var}===")) {
        return rhs.parse::<usize>().ok().map(|n| idx == n);
    }
    if let Some(rhs) = compact.strip_prefix(&format!("{index_var}!==")) {
        return rhs.parse::<usize>().ok().map(|n| idx != n);
    }
    if let Some(rhs) = compact.strip_prefix(&format!("{index_var}<")) {
        return rhs.parse::<usize>().ok().map(|n| idx < n);
    }
    if let Some(list_inner) = compact
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(&format!("].includes({index_var})")))
    {
        let mut nums = Vec::new();
        for part in list_inner.split(',') {
            nums.push(part.parse::<usize>().ok()?);
        }
        return Some(nums.contains(&idx));
    }
    None
}

fn strip_svelte_control_blocks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while cursor < text.len() {
        let rest = &text[cursor..];
        let next_pos = ["{#if ", "{:else", "{/if}", "{#each ", "{/each}"]
            .iter()
            .filter_map(|pat| rest.find(pat).map(|rel| cursor + rel))
            .min();
        let Some(pos) = next_pos else {
            out.push_str(rest);
            break;
        };
        out.push_str(&text[cursor..pos]);
        if let Some((_, after)) = find_directive_end(text, pos) {
            cursor = after;
        } else {
            out.push('{');
            cursor = pos + 1;
        }
    }
    out
}

fn replace_svg_blocks(text: &str) -> String {
    replace_paired_tag_blocks(text, "svg", |_attrs, inner| {
        let labels = extract_svg_text_labels(inner);
        if labels.is_empty() {
            String::new()
        } else {
            format!("\n{}\n", labels.join("\n"))
        }
    })
}

fn extract_svg_text_labels(svg_inner: &str) -> Vec<String> {
    let mut labels = Vec::new();
    let mut pos = 0usize;
    while let Some(rel) = svg_inner[pos..].find("<text") {
        let start = pos + rel;
        let after_name = start + 5;
        if !svg_inner[after_name..]
            .chars()
            .next()
            .is_some_and(|c| c.is_whitespace() || c == '>' || c == '/')
        {
            pos = after_name;
            continue;
        }
        let Some((tag_end, self_closing)) = find_tag_end(svg_inner, after_name) else {
            pos = after_name;
            continue;
        };
        if self_closing {
            pos = tag_end;
            continue;
        }
        let Some((close_start, close_end)) = find_closing_tag_range(svg_inner, tag_end, "text")
        else {
            pos = tag_end;
            continue;
        };
        let raw_label = strip_all_tags(&svg_inner[tag_end..close_start]);
        let decoded = decode_xml_entities(raw_label.trim());
        let cleaned = decoded.trim();
        if !cleaned.is_empty()
            && !matches!(cleaned, "↕" | "↓" | "↑" | "→" | "←" | "↔")
            && !(cleaned.starts_with('{') && cleaned.ends_with('}'))
        {
            let entry = format!("- {cleaned}");
            if labels.last() != Some(&entry) {
                labels.push(entry);
            }
        }
        pos = close_end;
    }
    labels
}

fn strip_all_tags(input: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

fn decode_xml_entities(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn strip_named_blocks(text: &str, names: &[&str]) -> String {
    let mut current = text.to_string();
    for &name in names {
        current = replace_paired_tag_blocks(&current, name, |attrs, _inner| {
            if name == "Chart" {
                if let Some(content) = attr_get(attrs, "content") {
                    if let Ok(val) = serde_json::from_str::<Value>(content) {
                        if let Some(footer) = val.pointer("/meta/footer").and_then(Value::as_str) {
                            let f = footer.trim();
                            if !f.is_empty() {
                                return format!("\n*{f}*\n");
                            }
                        }
                    }
                }
            }
            String::new()
        });
    }
    current
}

fn replace_divider_tags(text: &str) -> String {
    replace_paired_tag_blocks(text, "divider", |_attrs, _inner| "\n\n---\n\n".to_string())
}

fn replace_icon_tags(text: &str) -> String {
    replace_paired_tag_blocks(text, "icon", |attrs, _inner| {
        let name = attr_get(attrs, "name").unwrap_or("").trim();
        match name {
            "check" | "check-circle" | "check-circle-2" => "✓".to_string(),
            "alert-triangle" | "alert-circle" | "warning" => "⚠".to_string(),
            "x" | "x-circle" => "✗".to_string(),
            "minus" => "—".to_string(),
            "arrow-down" => "↓".to_string(),
            "arrow-right" => "→".to_string(),
            "info" => "ℹ".to_string(),
            _ => String::new(),
        }
    })
}

fn replace_inline_semantic_tags(text: &str) -> String {
    let mut out = replace_paired_tag_blocks(text, "badge", |_attrs, inner| {
        let cleaned = inner.trim();
        if cleaned.is_empty() {
            String::new()
        } else {
            format!("`{cleaned}`")
        }
    });
    out = replace_paired_tag_blocks(&out, "title", |_attrs, inner| {
        let cleaned = inner.trim();
        if cleaned.is_empty() || (cleaned.starts_with('{') && cleaned.ends_with('}')) {
            String::new()
        } else {
            format!("**{cleaned}**")
        }
    });
    out = replace_paired_tag_blocks(&out, "caption", |_attrs, inner| {
        let cleaned = inner.trim();
        if cleaned.is_empty() {
            String::new()
        } else {
            format!("*{cleaned}*")
        }
    });
    out = replace_paired_tag_blocks(&out, "label", |_attrs, inner| {
        let cleaned = inner.trim();
        if cleaned.is_empty() {
            String::new()
        } else {
            format!("**{cleaned}**")
        }
    });
    out
}

fn replace_list_blocks(text: &str) -> String {
    replace_paired_tag_blocks(text, "list", |attrs, inner| {
        let ordered = attr_get(attrs, "marker") == Some("number");
        let mut items = Vec::new();
        let mut pos = 0usize;
        while let Some(rel) = inner[pos..].find("<list-item") {
            let start = pos + rel;
            let after_name = start + "<list-item".len();
            if !inner[after_name..]
                .chars()
                .next()
                .is_some_and(|c| c.is_whitespace() || c == '>' || c == '/')
            {
                pos = after_name;
                continue;
            }
            let Some((tag_end, self_closing)) = find_tag_end(inner, after_name) else {
                pos = after_name;
                continue;
            };
            if self_closing {
                pos = tag_end;
                continue;
            }
            let Some((close_start, close_end)) = find_closing_tag_range(inner, tag_end, "list-item")
            else {
                pos = tag_end;
                continue;
            };
            let item_clean = unwrap_container_tags(&replace_row_blocks(&inner[tag_end..close_start]));
            let trimmed = item_clean.trim();
            if !trimmed.is_empty() {
                let prefix = if ordered {
                    format!("{}. ", items.len() + 1)
                } else {
                    "- ".to_string()
                };
                let mut lines = trimmed.lines();
                let mut item_text = String::new();
                if let Some(first) = lines.next() {
                    item_text.push_str(&prefix);
                    item_text.push_str(first.trim());
                }
                for rest in lines {
                    let t = rest.trim();
                    if !t.is_empty() {
                        item_text.push('\n');
                        item_text.push_str("  ");
                        item_text.push_str(t);
                    }
                }
                items.push(item_text);
            }
            pos = close_end;
        }
        if items.is_empty() {
            inner.to_string()
        } else {
            format!("\n{}\n", items.join("\n"))
        }
    })
}

fn replace_radio_groups(text: &str) -> String {
    replace_paired_tag_blocks(text, "radio-group", |_attrs, inner| {
        let mut items = Vec::new();
        let mut pos = 0usize;
        while let Some(rel) = inner[pos..].find("<radio") {
            let start = pos + rel;
            let after_name = start + "<radio".len();
            if !inner[after_name..]
                .chars()
                .next()
                .is_some_and(|c| c.is_whitespace() || c == '>' || c == '/')
            {
                pos = after_name;
                continue;
            }
            let Some((tag_end, self_closing)) = find_tag_end(inner, after_name) else {
                pos = after_name;
                continue;
            };
            if self_closing {
                pos = tag_end;
                continue;
            }
            let Some((close_start, close_end)) = find_closing_tag_range(inner, tag_end, "radio")
            else {
                pos = tag_end;
                continue;
            };
            let item_clean = unwrap_container_tags(&inner[tag_end..close_start]);
            let single = item_clean
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join(" — ");
            if !single.is_empty() {
                items.push(format!("- {single}"));
            }
            pos = close_end;
        }
        if items.is_empty() {
            inner.to_string()
        } else {
            format!("\n{}\n", items.join("\n"))
        }
    })
}

fn replace_widget_tables(text: &str) -> String {
    replace_paired_tag_blocks(text, "table", |attrs, inner| {
        if !inner.contains("<table-row") && !inner.contains("<table-cell") {
            if attrs.is_empty() {
                return format!("<table>{inner}</table>");
            }
            return inner.to_string();
        }
        let mut rows: Vec<Vec<String>> = Vec::new();
        let mut pos = 0usize;
        while let Some(rel) = inner[pos..].find("<table-row") {
            let start = pos + rel;
            let after_name = start + "<table-row".len();
            let Some((tag_end, self_closing)) = find_tag_end(inner, after_name) else {
                pos = after_name;
                continue;
            };
            if self_closing {
                pos = tag_end;
                continue;
            }
            let Some((close_start, close_end)) =
                find_closing_tag_range(inner, tag_end, "table-row")
            else {
                pos = tag_end;
                continue;
            };
            let row_inner = &inner[tag_end..close_start];
            let cells = extract_table_cells(row_inner);
            if !cells.is_empty() {
                rows.push(cells);
            }
            pos = close_end;
        }
        if rows.is_empty() {
            return String::new();
        }
        let col_count = rows.iter().map(Vec::len).max().unwrap_or(1);
        let format_row = |cells: &[String]| -> String {
            let mut padded = Vec::with_capacity(col_count);
            for i in 0..col_count {
                let cell = cells.get(i).map(String::as_str).unwrap_or("");
                padded.push(cell.replace('|', "\\|"));
            }
            format!("| {} |", padded.join(" | "))
        };
        let mut md_lines = Vec::with_capacity(rows.len() + 1);
        let has_header = rows.len() >= 2;
        if has_header {
            md_lines.push(format_row(&rows[0]));
            let sep = vec!["---"; col_count].join(" | ");
            md_lines.push(format!("| {sep} |"));
            for row in &rows[1..] {
                md_lines.push(format_row(row));
            }
        } else {
            let blank_head = vec![String::new(); col_count];
            md_lines.push(format_row(&blank_head));
            let sep = vec!["---"; col_count].join(" | ");
            md_lines.push(format!("| {sep} |"));
            md_lines.push(format_row(&rows[0]));
        }
        format!("\n{}\n", md_lines.join("\n"))
    })
}

fn extract_table_cells(row_inner: &str) -> Vec<String> {
    let mut cells = Vec::new();
    let mut pos = 0usize;
    while let Some(rel) = row_inner[pos..].find("<table-cell") {
        let start = pos + rel;
        let after_name = start + "<table-cell".len();
        let Some((tag_end, self_closing)) = find_tag_end(row_inner, after_name) else {
            pos = after_name;
            continue;
        };
        if self_closing {
            cells.push(String::new());
            pos = tag_end;
            continue;
        }
        let Some((close_start, close_end)) =
            find_closing_tag_range(row_inner, tag_end, "table-cell")
        else {
            pos = tag_end;
            continue;
        };
        let cleaned = unwrap_container_tags(&replace_row_blocks(&row_inner[tag_end..close_start]));
        let compact = cleaned
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        cells.push(compact);
        pos = close_end;
    }
    cells
}

fn replace_row_blocks(text: &str) -> String {
    replace_paired_tag_blocks(text, "row", |_attrs, inner| {
        let nested_resolved = replace_row_blocks(inner);
        let unwrapped = unwrap_container_tags(&nested_resolved);
        let parts: Vec<&str> = unwrapped
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        if parts.is_empty() {
            return String::new();
        }
        let all_short_inline = parts.len() <= 4
            && parts.iter().all(|p| {
                p.chars().count() <= 80
                    && !p.starts_with('#')
                    && !p.starts_with("- ")
                    && !p.starts_with("* ")
                    && !p.starts_with('|')
                    && !p.starts_with('>')
                    && !p.starts_with("```")
            });
        if all_short_inline {
            let mut joined = String::new();
            for (idx, part) in parts.iter().enumerate() {
                if idx > 0 {
                    let prev = parts[idx - 1];
                    if matches!(prev, "✓" | "⚠" | "✗" | "ℹ" | "↓" | "→" | "—") {
                        joined.push(' ');
                    } else {
                        joined.push_str(" · ");
                    }
                }
                joined.push_str(part);
            }
            format!("\n{joined}\n")
        } else {
            format!("\n{}\n", parts.join("\n"))
        }
    })
}

fn unwrap_container_tags(text: &str) -> String {
    const CONTAINER_TAGS: &[&str] = &[
        "box",
        "grid-item",
        "grid",
        "text",
        "button",
        "checkbox",
        "pressable",
        "segmented-control",
        "input",
        "slider",
        "textarea",
        "date-picker",
        "form",
        "radio",
    ];
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;

    while cursor < text.len() {
        let Some(rel_lt) = text[cursor..].find('<') else {
            out.push_str(&text[cursor..]);
            break;
        };
        let lt_pos = cursor + rel_lt;
        out.push_str(&text[cursor..lt_pos]);

        let rest = &text[lt_pos + 1..];
        let is_close = rest.starts_with('/');
        let name_slice = if is_close { &rest[1..] } else { rest };
        let matched = CONTAINER_TAGS.iter().find(|&&tag| {
            name_slice.starts_with(tag)
                && name_slice[tag.len()..]
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_whitespace() || c == '>' || c == '/')
        });

        let Some(&tag_name) = matched else {
            out.push('<');
            cursor = lt_pos + 1;
            continue;
        };

        let after_name = lt_pos + 1 + usize::from(is_close) + tag_name.len();
        let Some((tag_end, _)) = find_tag_end(text, after_name) else {
            out.push('<');
            cursor = lt_pos + 1;
            continue;
        };

        if !out.is_empty() && !out.ends_with('\n') && !matches!(tag_name, "text" | "button") {
            out.push('\n');
        }
        cursor = tag_end;
    }

    let mut dedented = String::with_capacity(out.len());
    for line in out.split_inclusive('\n') {
        let trimmed_ws = line.trim_start_matches([' ', '\t']);
        if trimmed_ws.starts_with('{') && trimmed_ws.trim().ends_with('}') {
            if line.ends_with('\n') {
                dedented.push('\n');
            }
            continue;
        }
        dedented.push_str(trimmed_ws);
    }
    dedented
}

fn replace_paired_tag_blocks<F>(text: &str, tag_name: &str, mut render: F) -> String
where
    F: FnMut(&[(String, AttrValue)], &str) -> String,
{
    let needle = format!("<{tag_name}");
    if !text.contains(&needle) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;

    while let Some(rel) = text[cursor..].find(&needle) {
        let start = cursor + rel;
        out.push_str(&text[cursor..start]);
        let after_name = start + needle.len();
        if !text[after_name..]
            .chars()
            .next()
            .is_some_and(|c| c.is_whitespace() || c == '>' || c == '/')
        {
            out.push_str(&needle);
            cursor = after_name;
            continue;
        }
        let Some((tag_end, self_closing)) = find_tag_end(text, after_name) else {
            out.push_str(&needle);
            cursor = after_name;
            continue;
        };
        let raw_attrs = text[after_name..tag_end - if self_closing { 2 } else { 1 }].trim();
        let attrs = parse_tag_attrs(raw_attrs);
        if self_closing {
            out.push_str(&render(&attrs, ""));
            cursor = tag_end;
            continue;
        }
        if let Some((close_start, close_end)) = find_closing_tag_range(text, tag_end, tag_name) {
            let inner = &text[tag_end..close_start];
            out.push_str(&render(&attrs, inner));
            cursor = close_end;
        } else {
            out.push_str(&render(&attrs, ""));
            cursor = tag_end;
        }
    }

    out.push_str(&text[cursor..]);
    out
}

fn normalize_whitespace(text: &str) -> String {
    let mut lines = Vec::new();
    let mut blank_run = 0usize;

    for raw_line in text.replace("\r\n", "\n").split('\n') {
        let cleaned_line = collapse_inline_double_spaces(raw_line).trim_end().to_string();
        if cleaned_line.trim().is_empty() {
            blank_run += 1;
            if blank_run <= 1 && !lines.is_empty() {
                lines.push(String::new());
            }
        } else {
            blank_run = 0;
            lines.push(cleaned_line);
        }
    }

    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    lines.join("\n").trim().to_string()
}

fn collapse_inline_double_spaces(line: &str) -> String {
    let trimmed_start = line.trim_start_matches([' ', '\t']);
    let leading_len = line.len() - trimmed_start.len();
    let mut out = String::with_capacity(line.len());
    out.push_str(&line[..leading_len]);

    let mut prev_space = false;
    for ch in trimmed_start.chars() {
        if ch == ' ' {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out
}
