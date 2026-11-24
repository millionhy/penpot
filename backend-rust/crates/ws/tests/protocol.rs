use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use tokio::sync::mpsc;
use transit::{Map, Value};
use uuid::Uuid;
use ws::{
    decode_client_message, AccessControl, AllowAllAccess, ClientMessage, InMemoryBus, Protocol,
    ProtocolOptions, RedisBus, Scope, ServerFrame, ZERO_TOPIC,
};

fn profile_id() -> Uuid {
    Uuid::parse_str("11111111-1111-4111-8111-111111111111").expect("profile uuid")
}

fn session_id() -> Uuid {
    Uuid::parse_str("22222222-2222-4222-8222-222222222222").expect("session uuid")
}

fn file_id() -> Uuid {
    Uuid::parse_str("33333333-3333-4333-8333-333333333333").expect("file uuid")
}

fn team_id() -> Uuid {
    Uuid::parse_str("44444444-4444-4444-8444-444444444444").expect("team uuid")
}

fn organization_id() -> Uuid {
    Uuid::parse_str("55555555-5555-4555-8555-555555555555").expect("organization uuid")
}

fn other_session_id() -> Uuid {
    Uuid::parse_str("66666666-6666-4666-8666-666666666666").expect("other session uuid")
}

fn encode(map: Map) -> String {
    transit::encode(&Value::Map(map))
}

fn subscribe_file(file_id: Uuid) -> String {
    encode(Map::from_iter([
        (Value::kw("type"), Value::kw("subscribe-file")),
        (Value::kw("file-id"), Value::Uuid(file_id)),
        (Value::kw("version"), Value::str("2.9.0")),
    ]))
}

fn subscribe_team(team_id: Uuid) -> String {
    encode(Map::from_iter([
        (Value::kw("type"), Value::kw("subscribe-team")),
        (Value::kw("team-id"), Value::Uuid(team_id)),
    ]))
}

fn unsubscribe_file(file_id: Uuid) -> String {
    encode(Map::from_iter([
        (Value::kw("type"), Value::kw("unsubscribe-file")),
        (Value::kw("file-id"), Value::Uuid(file_id)),
    ]))
}

fn pointer_update(file_id: Uuid) -> String {
    encode(Map::from_iter([
        (Value::kw("type"), Value::kw("pointer-update")),
        (Value::kw("file-id"), Value::Uuid(file_id)),
        (Value::kw("page-id"), Value::Uuid(Uuid::new_v4())),
        (Value::kw("zoom"), Value::Double(2.0)),
        (
            Value::kw("position"),
            Value::map([
                (Value::kw("x"), Value::Double(10.0)),
                (Value::kw("y"), Value::Double(20.0)),
            ]),
        ),
    ]))
}

fn join_file(session: Uuid) -> Map {
    Map::from_iter([
        (Value::kw("type"), Value::kw("join-file")),
        (Value::kw("file-id"), Value::Uuid(file_id())),
        (Value::kw("session-id"), Value::Uuid(session)),
        (Value::kw("profile-id"), Value::Uuid(Uuid::new_v4())),
    ])
}

struct TeamOrg;

#[async_trait]
impl AccessControl for TeamOrg {
    async fn can_subscribe_team(&self, _profile: Uuid, _team: Uuid) -> ws::Result<Option<Uuid>> {
        Ok(Some(organization_id()))
    }

    async fn can_subscribe_file(&self, _profile: Uuid, _file: Uuid) -> ws::Result<()> {
        Ok(())
    }
}

fn protocol(bus: Arc<InMemoryBus>, access: Arc<dyn AccessControl>) -> Protocol {
    Protocol::new(
        bus,
        access,
        profile_id(),
        session_id(),
        ProtocolOptions::default(),
    )
}

async fn recv_frame(receiver: &mut mpsc::Receiver<ServerFrame>) -> Map {
    match tokio::time::timeout(Duration::from_secs(1), receiver.recv())
        .await
        .expect("frame timeout")
        .expect("frame")
    {
        ServerFrame::Message(message) => message,
        other => panic!("expected message frame, got {other:?}"),
    }
}

async fn recv_bus(receiver: &mut mpsc::Receiver<Map>) -> Map {
    tokio::time::timeout(Duration::from_secs(1), receiver.recv())
        .await
        .expect("bus timeout")
        .expect("bus message")
}

#[test]
fn client_messages_decode_the_frontend_wire_shape() {
    let decoded = decode_client_message(&subscribe_file(file_id())).expect("decode");
    assert!(matches!(
        decoded,
        ClientMessage::SubscribeFile { file_id: id, .. } if id == file_id()
    ));

    let decoded = decode_client_message(&pointer_update(file_id())).expect("decode");
    assert!(matches!(
        decoded,
        ClientMessage::PointerUpdate { file_id: id, .. } if id == file_id()
    ));
}

#[test]
fn client_message_rejects_a_string_file_id() {
    let raw = encode(Map::from_iter([
        (Value::kw("type"), Value::kw("subscribe-file")),
        (Value::kw("file-id"), Value::str(file_id().to_string())),
    ]));
    assert!(decode_client_message(&raw).is_err());
}

#[tokio::test]
async fn open_subscribes_the_profile_and_the_zero_topic() {
    let bus = Arc::new(InMemoryBus::new("acme"));
    let mut connection = protocol(bus.clone(), Arc::new(AllowAllAccess));

    connection.open().await.expect("open");

    assert_eq!(bus.subscriber_count(&profile_id().to_string()), 1);
    assert_eq!(bus.subscriber_count(ZERO_TOPIC), 1);
}

#[tokio::test]
async fn subscribe_team_uses_the_resolved_organization_and_replaces_the_previous_team() {
    let bus = Arc::new(InMemoryBus::new("acme"));
    let mut connection = protocol(bus.clone(), Arc::new(TeamOrg));
    let (outbound, _outbound_rx) = mpsc::channel(8);
    connection.open().await.expect("open");

    connection
        .handle_client_text(&subscribe_team(team_id()), &outbound)
        .await
        .expect("subscribe team");

    assert_eq!(bus.subscriber_count(&team_id().to_string()), 1);
    assert_eq!(bus.subscriber_count(&organization_id().to_string()), 1);

    let next_team = Uuid::new_v4();
    connection
        .handle_client_text(&subscribe_team(next_team), &outbound)
        .await
        .expect("replace team");

    assert_eq!(bus.subscriber_count(&team_id().to_string()), 0);
    assert_eq!(bus.subscriber_count(&organization_id().to_string()), 1);
    assert_eq!(bus.subscriber_count(&next_team.to_string()), 1);
}

#[tokio::test]
async fn subscribe_file_publishes_join_file_and_the_sender_filters_its_own_session() {
    let bus = Arc::new(InMemoryBus::new("acme"));
    let (observer_tx, mut observer_rx) = mpsc::channel(8);
    let _observer = bus
        .subscribe(&[file_id().to_string()], 8, observer_tx)
        .await
        .expect("observer");

    let mut connection = protocol(bus.clone(), Arc::new(AllowAllAccess));
    let (outbound, mut outbound_rx) = mpsc::channel(8);
    connection.open().await.expect("open");
    connection
        .handle_client_text(&subscribe_file(file_id()), &outbound)
        .await
        .expect("subscribe file");

    let joined = recv_bus(&mut observer_rx).await;
    assert_eq!(joined.get_kw("type"), Some(&Value::kw("join-file")));
    assert_eq!(
        joined.get_kw("session-id"),
        Some(&Value::Uuid(session_id()))
    );
    assert!(matches!(
        outbound_rx.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn a_join_file_from_another_session_is_forwarded_and_announced_as_presence() {
    let bus = Arc::new(InMemoryBus::new("acme"));
    let (observer_tx, mut observer_rx) = mpsc::channel(8);
    let _observer = bus
        .subscribe(&[file_id().to_string()], 8, observer_tx)
        .await
        .expect("observer");

    let mut connection = protocol(bus.clone(), Arc::new(AllowAllAccess));
    let (outbound, mut outbound_rx) = mpsc::channel(8);
    connection.open().await.expect("open");
    connection
        .handle_client_text(&subscribe_file(file_id()), &outbound)
        .await
        .expect("subscribe file");
    let _join = recv_bus(&mut observer_rx).await;

    connection
        .handle_bus_message(Scope::File, join_file(other_session_id()), &outbound)
        .await
        .expect("file delivery");

    let forwarded = recv_frame(&mut outbound_rx).await;
    assert_eq!(forwarded.get_kw("type"), Some(&Value::kw("join-file")));
    let presence = recv_bus(&mut observer_rx).await;
    assert_eq!(presence.get_kw("type"), Some(&Value::kw("presence")));
    assert_eq!(
        presence.get_kw("session-id"),
        Some(&Value::Uuid(session_id()))
    );
}

#[tokio::test]
async fn unsubscribe_file_announces_leave_and_removes_the_topic() {
    let bus = Arc::new(InMemoryBus::new("acme"));
    let (observer_tx, mut observer_rx) = mpsc::channel(8);
    let _observer = bus
        .subscribe(&[file_id().to_string()], 8, observer_tx)
        .await
        .expect("observer");

    let mut connection = protocol(bus.clone(), Arc::new(AllowAllAccess));
    let (outbound, _outbound_rx) = mpsc::channel(8);
    connection.open().await.expect("open");
    connection
        .handle_client_text(&subscribe_file(file_id()), &outbound)
        .await
        .expect("subscribe file");
    let _join = recv_bus(&mut observer_rx).await;

    connection
        .handle_client_text(&unsubscribe_file(file_id()), &outbound)
        .await
        .expect("unsubscribe file");

    let leave = recv_bus(&mut observer_rx).await;
    assert_eq!(leave.get_kw("type"), Some(&Value::kw("leave-file")));
    assert_eq!(bus.subscriber_count(&file_id().to_string()), 1);
}

#[tokio::test]
async fn pointer_update_requires_the_active_file_and_adds_the_sender_fields() {
    let bus = Arc::new(InMemoryBus::new("acme"));
    let (observer_tx, mut observer_rx) = mpsc::channel(8);
    let _observer = bus
        .subscribe(&[file_id().to_string()], 8, observer_tx)
        .await
        .expect("observer");

    let mut connection = protocol(bus.clone(), Arc::new(AllowAllAccess));
    let (outbound, _outbound_rx) = mpsc::channel(8);
    connection.open().await.expect("open");
    connection
        .handle_client_text(&subscribe_file(file_id()), &outbound)
        .await
        .expect("subscribe file");
    let _join = recv_bus(&mut observer_rx).await;

    connection
        .handle_client_text(&pointer_update(file_id()), &outbound)
        .await
        .expect("pointer");

    let pointer = recv_bus(&mut observer_rx).await;
    assert_eq!(pointer.get_kw("type"), Some(&Value::kw("pointer-update")));
    assert_eq!(pointer.get_kw("subs-id"), Some(&Value::Uuid(file_id())));
    assert_eq!(
        pointer.get_kw("profile-id"),
        Some(&Value::Uuid(profile_id()))
    );
    assert_eq!(
        pointer.get_kw("session-id"),
        Some(&Value::Uuid(session_id()))
    );
}

#[tokio::test]
async fn shutdown_announces_disconnect_and_closes_every_subscription() {
    let bus = Arc::new(InMemoryBus::new("acme"));
    let (observer_tx, mut observer_rx) = mpsc::channel(8);
    let _observer = bus
        .subscribe(&[file_id().to_string()], 8, observer_tx)
        .await
        .expect("observer");

    let mut connection = protocol(bus.clone(), Arc::new(AllowAllAccess));
    let (outbound, _outbound_rx) = mpsc::channel(8);
    connection.open().await.expect("open");
    connection
        .handle_client_text(&subscribe_file(file_id()), &outbound)
        .await
        .expect("subscribe file");
    let _join = recv_bus(&mut observer_rx).await;

    connection.shutdown().await;

    let disconnect = recv_bus(&mut observer_rx).await;
    assert_eq!(disconnect.get_kw("type"), Some(&Value::kw("disconnect")));
    assert!(disconnect.get_kw("file-id").is_none());
    assert_eq!(
        disconnect.get_kw("session-id"),
        Some(&Value::Uuid(session_id()))
    );
    assert_eq!(bus.subscriber_count(&file_id().to_string()), 1);
    assert_eq!(bus.subscriber_count(&profile_id().to_string()), 0);
}

#[tokio::test]
async fn keepalive_and_unknown_messages_do_not_emit_frames() {
    let bus = Arc::new(InMemoryBus::new("acme"));
    let mut connection = protocol(bus, Arc::new(AllowAllAccess));
    let (outbound, mut outbound_rx) = mpsc::channel(8);
    connection.open().await.expect("open");

    for kind in ["keepalive", "not-a-penpot-message"] {
        let raw = encode(Map::from_iter([(Value::kw("type"), Value::kw(kind))]));
        connection
            .handle_client_text(&raw, &outbound)
            .await
            .expect("message");
    }

    assert!(matches!(
        outbound_rx.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
}
