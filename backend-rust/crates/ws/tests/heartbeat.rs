use ws::{Heartbeat, WsError};

#[test]
fn each_ping_carries_the_next_sequence_number() {
    let mut heartbeat = Heartbeat::new(3);

    assert_eq!(heartbeat.next_ping().expect("first"), 0_i64.to_be_bytes());
    assert_eq!(heartbeat.outstanding(), 1);
    assert!(heartbeat.on_pong(&0_i64.to_be_bytes()));
    assert_eq!(heartbeat.outstanding(), 0);

    assert_eq!(heartbeat.next_ping().expect("second"), 1_i64.to_be_bytes());
}

#[test]
fn three_missed_pongs_stop_the_heartbeat() {
    let mut heartbeat = Heartbeat::new(3);

    for _ in 0..3 {
        heartbeat.next_ping().expect("within limit");
    }

    assert!(matches!(
        heartbeat.next_ping(),
        Err(WsError::HeartbeatTimeout)
    ));
    assert_eq!(heartbeat.outstanding(), 3);
}

#[test]
fn a_matching_pong_clears_only_its_own_beat() {
    let mut heartbeat = Heartbeat::new(3);
    let first = heartbeat.next_ping().expect("first");
    let second = heartbeat.next_ping().expect("second");

    assert!(heartbeat.on_pong(&second));
    assert_eq!(heartbeat.outstanding(), 1);
    assert!(heartbeat.on_pong(&first));
    assert_eq!(heartbeat.outstanding(), 0);
}

#[test]
fn malformed_pongs_are_ignored() {
    let mut heartbeat = Heartbeat::new(3);
    let ping = heartbeat.next_ping().expect("ping");

    assert!(!heartbeat.on_pong(&ping[..4]));
    assert!(!heartbeat.on_pong(&[]));
    assert_eq!(heartbeat.outstanding(), 1);
}
