//! Quartz cron parsing and next-instant calculation.
//!
//! The backend uses Log4j's `CronExpression` through `#penpot/cron`. The
//! parser here keeps the same six required fields, optional year, `?`, `L`,
//! `W`, `#`, names, lists, ranges and steps.

use std::{fmt, str::FromStr};

use chrono::{
    DateTime, Datelike, Days, Local, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Utc, Weekday,
};
use transit::Map;

use crate::{Result, WorkerError};

const MIN_YEAR: u32 = 1970;
const MAX_YEAR: u32 = 2199;
const MAX_SEARCH_DAYS: u64 = 366 * 180;

const MONTH_NAMES: &[(&str, u32)] = &[
    ("JAN", 1),
    ("FEB", 2),
    ("MAR", 3),
    ("APR", 4),
    ("MAY", 5),
    ("JUN", 6),
    ("JUL", 7),
    ("AUG", 8),
    ("SEP", 9),
    ("OCT", 10),
    ("NOV", 11),
    ("DEC", 12),
];

const WEEKDAY_NAMES: &[(&str, u32)] = &[
    ("SUN", 1),
    ("MON", 2),
    ("TUE", 3),
    ("WED", 4),
    ("THU", 5),
    ("FRI", 6),
    ("SAT", 7),
];

/// A parsed Quartz expression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronExpression {
    expr: String,
    seconds: Vec<u32>,
    minutes: Vec<u32>,
    hours: Vec<u32>,
    days_of_month: DayOfMonth,
    months: Vec<u32>,
    days_of_week: DayOfWeek,
    years: Option<Vec<u32>>,
}

impl CronExpression {
    /// Parse a six- or seven-field Quartz expression.
    ///
    /// # Errors
    ///
    /// Returns [`WorkerError::InvalidCron`] when a field count, value, range,
    /// step or special form does not match Quartz rules.
    pub fn parse(expr: &str) -> Result<Self> {
        let expr = expr.trim();
        let fields: Vec<_> = expr.split_whitespace().collect();
        if !matches!(fields.len(), 6 | 7) {
            return Err(invalid(expr, "expected 6 or 7 fields"));
        }

        let seconds = parse_values(fields[0], 0, 59, &[], expr)?;
        let minutes = parse_values(fields[1], 0, 59, &[], expr)?;
        let hours = parse_values(fields[2], 0, 23, &[], expr)?;
        let days_of_month = parse_day_of_month(fields[3], expr)?;
        let months = parse_values(fields[4], 1, 12, MONTH_NAMES, expr)?;
        let days_of_week = parse_day_of_week(fields[5], expr)?;
        let years = fields
            .get(6)
            .map(|field| parse_values(field, MIN_YEAR, MAX_YEAR, &[], expr))
            .transpose()?;

        if days_of_month.is_restricted() && days_of_week.is_restricted() {
            return Err(invalid(
                expr,
                "day-of-month and day-of-week cannot both be restricted",
            ));
        }

        Ok(Self {
            expr: expr.to_owned(),
            seconds,
            minutes,
            hours,
            days_of_month,
            months,
            days_of_week,
            years,
        })
    }

    /// Original expression with surrounding whitespace removed.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.expr
    }

    /// Next matching instant strictly after `now`, evaluated in `timezone`.
    #[must_use]
    pub fn next_after<Tz: TimeZone>(
        &self,
        now: DateTime<Utc>,
        timezone: &Tz,
    ) -> Option<DateTime<Utc>> {
        let local_now = now.with_timezone(timezone);
        let start_date = local_now.date_naive();
        let local_now_naive = local_now.naive_local();

        for offset in 0..=MAX_SEARCH_DAYS {
            let date = start_date.checked_add_days(Days::new(offset))?;
            if !self.matches_date(date) {
                continue;
            }

            for hour in &self.hours {
                for minute in &self.minutes {
                    for second in &self.seconds {
                        let Some(time) = date.and_hms_opt(*hour, *minute, *second) else {
                            continue;
                        };
                        if offset == 0 && time <= local_now_naive {
                            continue;
                        }
                        if let Some(candidate) = local_candidate(timezone, time, now) {
                            return Some(candidate);
                        }
                    }
                }
            }
        }

        None
    }

    /// Next matching instant using the host's local timezone.
    #[must_use]
    pub fn next_after_local(&self, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
        self.next_after(now, &Local)
    }

    fn matches_date(&self, date: NaiveDate) -> bool {
        if !self.months.contains(&date.month()) {
            return false;
        }
        if let Some(years) = &self.years {
            let year = u32::try_from(date.year()).unwrap_or_default();
            if !years.contains(&year) {
                return false;
            }
        }
        self.days_of_month.matches(date) && self.days_of_week.matches(date)
    }
}

impl fmt::Display for CronExpression {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.expr)
    }
}

impl FromStr for CronExpression {
    type Err = WorkerError;

    fn from_str(value: &str) -> Result<Self> {
        Self::parse(value)
    }
}

/// One `scheduled_task` entry.
#[derive(Debug, Clone, PartialEq)]
pub struct CronEntry {
    /// Primary key; defaults to the task name.
    pub id: String,
    /// Registered task name.
    pub task: String,
    /// Parsed Quartz expression.
    pub cron: CronExpression,
    /// Transit props passed to the task.
    pub props: Map,
}

impl CronEntry {
    /// Build an entry whose id defaults to the task name.
    ///
    /// # Errors
    ///
    /// Returns [`WorkerError::InvalidCron`] when `cron` does not parse.
    pub fn new(task: impl Into<String>, cron: &str, props: Map) -> Result<Self> {
        let task = task.into();
        Ok(Self {
            id: task.clone(),
            task,
            cron: CronExpression::parse(cron)?,
            props,
        })
    }

    /// Override the `scheduled_task.id`.
    #[must_use]
    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = id.into();
        self
    }
}

/// Upsert a cron row without replacing an existing expression.
pub const SQL_UPSERT_CRON_TASK: &str = "insert into scheduled_task (id, cron_expr)
   values (?, ?)
       on conflict (id)
       do nothing";

/// Serialize one cron tick with PostgreSQL row locking.
pub const SQL_LOCK_SCHEDULED_TASK: &str =
    "SELECT id FROM scheduled_task WHERE id=? FOR UPDATE SKIP LOCKED";

/// The ten cron literals in `backend/src/app/main.clj`.
pub const PENPOT_CRON_EXPRESSIONS: [&str; 10] = [
    "0 0 0 * * ?",
    "0 0 0 * * ?",
    "0 0 0 * * ?",
    "0 0 0 * * ?",
    "0 0 0 * * ?",
    "0 0 0 * * ?",
    "0 0 2 * * ?",
    "0 30 */3,23 * * ?",
    "0 */5 * * * ?",
    "30 */5 * * * ?",
];

/// Parse every cron literal currently registered by the backend.
///
/// # Errors
///
/// Returns [`WorkerError::InvalidCron`] if any registered literal fails to
/// parse.
pub fn validate_penpot_entries() -> Result<Vec<CronExpression>> {
    PENPOT_CRON_EXPRESSIONS
        .into_iter()
        .map(CronExpression::parse)
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DayOfMonth {
    All,
    Days(Vec<u32>),
    Last,
    LastOffset(u32),
    NearestWeekday(u32),
    LastWeekday,
}

impl DayOfMonth {
    const fn is_restricted(&self) -> bool {
        !matches!(self, Self::All)
    }

    fn matches(&self, date: NaiveDate) -> bool {
        let day = date.day();
        let last = last_day(date.year(), date.month());
        match self {
            Self::All => true,
            Self::Days(days) => days.contains(&day),
            Self::Last => day == last,
            Self::LastOffset(offset) => last.checked_sub(*offset) == Some(day),
            Self::NearestWeekday(target) => nearest_weekday(date, *target) == Some(day),
            Self::LastWeekday => last_weekday(date) == Some(day),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DayOfWeek {
    All,
    Days(Vec<u32>),
    Last(u32),
    Nth(u32, u32),
}

impl DayOfWeek {
    const fn is_restricted(&self) -> bool {
        !matches!(self, Self::All)
    }

    fn matches(&self, date: NaiveDate) -> bool {
        let weekday = quartz_weekday(date.weekday());
        let day = date.day();
        let last = last_day(date.year(), date.month());
        match self {
            Self::All => true,
            Self::Days(days) => days.contains(&weekday),
            Self::Last(target) => weekday == *target && day + 7 > last,
            Self::Nth(target, occurrence) => weekday == *target && (day - 1) / 7 + 1 == *occurrence,
        }
    }
}

fn parse_day_of_month(field: &str, expr: &str) -> Result<DayOfMonth> {
    let value = field.trim().to_ascii_uppercase();
    if matches!(value.as_str(), "*" | "?") {
        return Ok(DayOfMonth::All);
    }
    if value == "LW" {
        return Ok(DayOfMonth::LastWeekday);
    }
    if value == "L" {
        return Ok(DayOfMonth::Last);
    }
    if let Some(offset) = value.strip_prefix("L-") {
        let offset = parse_number(offset, 0, 30, expr)?;
        return Ok(DayOfMonth::LastOffset(offset));
    }
    if let Some(target) = value.strip_suffix('W') {
        if value.contains(',') || value.contains('-') {
            return Err(invalid(expr, "`W` must name one day-of-month"));
        }
        let target = parse_number(target, 1, 31, expr)?;
        return Ok(DayOfMonth::NearestWeekday(target));
    }
    if value.contains('L') || value.contains('W') {
        return Err(invalid(expr, "invalid day-of-month special form"));
    }
    Ok(DayOfMonth::Days(parse_values(&value, 1, 31, &[], expr)?))
}

fn parse_day_of_week(field: &str, expr: &str) -> Result<DayOfWeek> {
    let value = field.trim().to_ascii_uppercase();
    if matches!(value.as_str(), "*" | "?") {
        return Ok(DayOfWeek::All);
    }
    if value == "L" {
        return Ok(DayOfWeek::Days(vec![7]));
    }
    if let Some((day, occurrence)) = value.split_once('#') {
        if value.matches('#').count() != 1 || value.contains(',') {
            return Err(invalid(expr, "`#` accepts one weekday expression"));
        }
        let day = parse_named_number(day, 1, 7, WEEKDAY_NAMES, expr)?;
        let occurrence = parse_number(occurrence, 1, 5, expr)?;
        return Ok(DayOfWeek::Nth(day, occurrence));
    }
    if let Some(day) = value.strip_suffix('L') {
        if value.contains(',') {
            return Err(invalid(expr, "`L` must name one weekday"));
        }
        let day = parse_named_number(day, 1, 7, WEEKDAY_NAMES, expr)?;
        return Ok(DayOfWeek::Last(day));
    }
    if value.contains('L') || value.contains('#') {
        return Err(invalid(expr, "invalid day-of-week special form"));
    }
    Ok(DayOfWeek::Days(parse_values(
        &value,
        1,
        7,
        WEEKDAY_NAMES,
        expr,
    )?))
}

fn parse_values(
    field: &str,
    min: u32,
    max: u32,
    names: &[(&str, u32)],
    expr: &str,
) -> Result<Vec<u32>> {
    let mut values = Vec::new();
    for item in field.split(',') {
        if item.is_empty() {
            return Err(invalid(expr, "empty list item"));
        }
        parse_item(item, min, max, names, expr, &mut values)?;
    }
    values.sort_unstable();
    values.dedup();
    if values.is_empty() {
        return Err(invalid(expr, "field selects no values"));
    }
    Ok(values)
}

fn parse_item(
    item: &str,
    min: u32,
    max: u32,
    names: &[(&str, u32)],
    expr: &str,
    values: &mut Vec<u32>,
) -> Result<()> {
    let (base, step) = match item.split_once('/') {
        Some((base, step)) => {
            let step = parse_number(step, 1, u32::MAX, expr)?;
            (base, Some(step))
        }
        None => (item, None),
    };
    let step = step.unwrap_or(1);

    if base == "*" {
        for value in (min..=max).step_by(usize::try_from(step).unwrap_or(usize::MAX)) {
            values.push(value);
        }
        return Ok(());
    }

    if let Some((start, end)) = base.split_once('-') {
        let start = parse_named_number(start, min, max, names, expr)?;
        let end = parse_named_number(end, min, max, names, expr)?;
        if start > end {
            return Err(invalid(expr, "range start is greater than range end"));
        }
        for value in (start..=end).step_by(usize::try_from(step).unwrap_or(usize::MAX)) {
            values.push(value);
        }
        return Ok(());
    }

    let start = parse_named_number(base, min, max, names, expr)?;
    if item.contains('/') {
        for value in (start..=max).step_by(usize::try_from(step).unwrap_or(usize::MAX)) {
            values.push(value);
        }
    } else {
        values.push(start);
    }
    Ok(())
}

fn parse_named_number(
    value: &str,
    min: u32,
    max: u32,
    names: &[(&str, u32)],
    expr: &str,
) -> Result<u32> {
    if let Some((_, number)) = names
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(value))
    {
        return Ok(*number);
    }
    parse_number(value, min, max, expr)
}

fn parse_number(value: &str, min: u32, max: u32, expr: &str) -> Result<u32> {
    let number = value
        .parse::<u32>()
        .map_err(|_| invalid(expr, format!("`{value}` is not a number")))?;
    if number < min || number > max {
        return Err(invalid(
            expr,
            format!("`{number}` is outside {min}..={max}"),
        ));
    }
    Ok(number)
}

fn local_candidate<Tz: TimeZone>(
    timezone: &Tz,
    local: NaiveDateTime,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    match timezone.from_local_datetime(&local) {
        LocalResult::Single(value) => {
            let value = value.with_timezone(&Utc);
            (value > now).then_some(value)
        }
        LocalResult::Ambiguous(first, second) => [first, second]
            .into_iter()
            .map(|value| value.with_timezone(&Utc))
            .filter(|value| *value > now)
            .min(),
        LocalResult::None => None,
    }
}

fn last_day(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .and_then(|date| date.pred_opt())
        .map_or(31, |date| date.day())
}

fn nearest_weekday(date: NaiveDate, target: u32) -> Option<u32> {
    let last = last_day(date.year(), date.month());
    if target > last {
        return None;
    }
    let target_date = NaiveDate::from_ymd_opt(date.year(), date.month(), target)?;
    let adjusted = match target_date.weekday() {
        Weekday::Sat if target == 1 => target + 2,
        Weekday::Sat => target - 1,
        Weekday::Sun if target == last => target - 2,
        Weekday::Sun => target + 1,
        _ => target,
    };
    Some(adjusted)
}

fn last_weekday(date: NaiveDate) -> Option<u32> {
    let last = last_day(date.year(), date.month());
    let last_date = NaiveDate::from_ymd_opt(date.year(), date.month(), last)?;
    Some(match last_date.weekday() {
        Weekday::Sat => last - 1,
        Weekday::Sun => last - 2,
        _ => last,
    })
}

const fn quartz_weekday(weekday: Weekday) -> u32 {
    match weekday {
        Weekday::Mon => 2,
        Weekday::Tue => 3,
        Weekday::Wed => 4,
        Weekday::Thu => 5,
        Weekday::Fri => 6,
        Weekday::Sat => 7,
        Weekday::Sun => 1,
    }
}

fn invalid(expr: &str, reason: impl Into<String>) -> WorkerError {
    WorkerError::InvalidCron {
        expr: expr.to_owned(),
        reason: reason.into(),
    }
}
