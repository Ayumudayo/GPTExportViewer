use chrono::{DateTime, Utc};

pub fn to_iso_time(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return DateTime::parse_from_rfc3339(text).ok().map(|parsed| {
            parsed
                .with_timezone(&Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });
    }
    let number = value.as_f64()?;
    let millis = if number > 10_000_000_000.0 {
        number as i64
    } else {
        (number * 1000.0) as i64
    };
    DateTime::<Utc>::from_timestamp_millis(millis)
        .map(|parsed| parsed.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

pub fn generated_at() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
