pub fn to_iso_time_from_epoch_seconds(value: f64) -> String {
    let millis = if value > 10_000_000_000.0 {
        value as i128
    } else {
        (value * 1000.0) as i128
    };
    millis.to_string()
}
