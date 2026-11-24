use chrono::{FixedOffset, TimeDelta, TimeZone, Utc};
use worker::CronExpression;

fn cron(expr: &str) -> CronExpression {
    CronExpression::parse(expr).unwrap_or_else(|error| panic!("{expr}: {error}"))
}

fn at(
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
) -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(year, month, day, hour, minute, second)
        .single()
        .expect("valid test instant")
}

#[test]
fn daily_midnight_advances_to_the_next_day() {
    let next = cron("0 0 0 * * ?")
        .next_after(at(2026, 11, 24, 12, 0, 0), &Utc)
        .expect("next midnight");

    assert_eq!(next, at(2026, 11, 25, 0, 0, 0));
}

#[test]
fn seconds_step_rounds_forward() {
    let next = cron("*/15 * * * * ?")
        .next_after(at(2026, 11, 24, 12, 0, 7), &Utc)
        .expect("next quarter");

    assert_eq!(next, at(2026, 11, 24, 12, 0, 15));
}

#[test]
fn list_and_range_expand_in_the_hour_field() {
    let next = cron("0 30 */3,23 * * ?")
        .next_after(at(2026, 11, 24, 12, 31, 0), &Utc)
        .expect("next three-hour slot");

    assert_eq!(next, at(2026, 11, 24, 15, 30, 0));
}

#[test]
fn weekday_range_skips_the_weekend() {
    let next = cron("0 0 9 ? * MON-FRI")
        .next_after(at(2026, 11, 27, 10, 0, 0), &Utc)
        .expect("next weekday");

    assert_eq!(next, at(2026, 11, 30, 9, 0, 0));
}

#[test]
fn last_day_of_month_matches_short_months() {
    let next = cron("0 0 0 L * ?")
        .next_after(at(2027, 1, 1, 0, 0, 0), &Utc)
        .expect("last day");

    assert_eq!(next, at(2027, 1, 31, 0, 0, 0));
}

#[test]
fn last_day_offset_subtracts_calendar_days() {
    let next = cron("0 0 0 L-3 * ?")
        .next_after(at(2027, 1, 1, 0, 0, 0), &Utc)
        .expect("third-to-last day");

    assert_eq!(next, at(2027, 1, 28, 0, 0, 0));
}

#[test]
fn nearest_weekday_never_crosses_the_month_boundary() {
    let next = cron("0 0 0 1W * ?")
        .next_after(at(2026, 7, 1, 0, 0, 0), &Utc)
        .expect("first weekday");

    assert_eq!(next, at(2026, 8, 3, 0, 0, 0));
}

#[test]
fn nearest_weekday_moves_backward_from_sunday() {
    let next = cron("0 0 0 31W * ?")
        .next_after(at(2026, 5, 1, 0, 0, 0), &Utc)
        .expect("last weekday in May");

    assert_eq!(next, at(2026, 5, 29, 0, 0, 0));
}

#[test]
fn last_weekday_of_month_uses_the_weekday_calendar() {
    let next = cron("0 0 0 LW * ?")
        .next_after(at(2026, 11, 1, 0, 0, 0), &Utc)
        .expect("last weekday");

    assert_eq!(next, at(2026, 11, 30, 0, 0, 0));
}

#[test]
fn nth_weekday_selects_the_requested_occurrence() {
    let next = cron("0 0 9 ? * 2#1")
        .next_after(at(2026, 11, 24, 12, 0, 0), &Utc)
        .expect("first Monday");

    assert_eq!(next, at(2026, 12, 7, 9, 0, 0));
}

#[test]
fn last_named_weekday_selects_the_final_occurrence() {
    let next = cron("0 0 9 ? * 6L")
        .next_after(at(2026, 11, 24, 12, 0, 0), &Utc)
        .expect("last Friday");

    assert_eq!(next, at(2026, 11, 27, 9, 0, 0));
}

#[test]
fn lone_last_in_weekday_field_means_saturday() {
    let next = cron("0 0 9 ? * L")
        .next_after(at(2026, 11, 24, 12, 0, 0), &Utc)
        .expect("next Saturday");

    assert_eq!(next, at(2026, 11, 28, 9, 0, 0));
}

#[test]
fn optional_year_field_bounds_the_search() {
    let next = cron("0 0 0 1 1 ? 2030")
        .next_after(at(2026, 1, 1, 0, 0, 0), &Utc)
        .expect("year 2030");

    assert_eq!(next, at(2030, 1, 1, 0, 0, 0));
}

#[test]
fn month_and_weekday_names_are_case_insensitive() {
    let next = cron("0 0 9 ? jan mon 2030")
        .next_after(at(2026, 1, 1, 0, 0, 0), &Utc)
        .expect("named month and weekday");

    assert_eq!(next, at(2030, 1, 7, 9, 0, 0));
}

#[test]
fn leap_day_is_found_in_the_next_leap_year() {
    let next = cron("0 0 0 29 2 ?")
        .next_after(at(2026, 3, 1, 0, 0, 0), &Utc)
        .expect("next leap day");

    assert_eq!(next, at(2028, 2, 29, 0, 0, 0));
}

#[test]
fn timezone_decides_the_local_midnight() {
    let timezone = FixedOffset::east_opt(8 * 3600).expect("UTC+8");
    let now = Utc
        .with_ymd_and_hms(2026, 11, 24, 15, 59, 59)
        .single()
        .expect("valid instant");

    let next = cron("0 0 0 * * ?")
        .next_after(now, &timezone)
        .expect("local midnight");

    assert_eq!(next, at(2026, 11, 24, 16, 0, 0));
}

#[test]
fn next_match_is_strictly_after_the_input() {
    let now = at(2026, 11, 24, 12, 0, 0);
    let next = cron("0 0 12 * * ?").next_after(now, &Utc);

    assert_eq!(next, Some(now + TimeDelta::days(1)));
}

#[test]
fn invalid_expressions_are_rejected() {
    for expr in [
        "",
        "* * *",
        "60 * * * * ?",
        "* 60 * * * ?",
        "* * 24 * * ?",
        "* * * 0 * ?",
        "* * * * 13 ?",
        "0 0 0 ? * 8",
        "0 0 0 15 * MON",
        "0 0 0 ? * 2#6",
        "0 0 0 15W,16 * ?",
        "0 0 0 1 1 ? 1969",
        "0 0 0 1 1 ? 2200",
    ] {
        assert!(
            CronExpression::parse(expr).is_err(),
            "expected invalid expression: {expr}"
        );
    }
}

#[test]
fn display_preserves_the_trimmed_expression() {
    let expression = cron(" 0 30 */3,23 * * ? ");

    assert_eq!(expression.to_string(), "0 30 */3,23 * * ?");
}
