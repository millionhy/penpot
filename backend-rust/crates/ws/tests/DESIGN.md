# ws live compatibility test design

The offline crate stops at the `RedisBus` trait and `InMemoryBus`. This file
records what the live adapter and its tests must prove once a devenv is
available.

## Adapter shape

- One long-lived pub/sub connection per process, one normal connection for
  `PUBLISH`.
- Every logical topic goes through `prefix_topic(tenant, topic)` exactly once.
  Subscription state is keyed by the logical topic, the wire subscription and
  publish channel use the prefixed topic.
- Keep the local count map from `InMemoryBus`: the first local sender issues
  `SUBSCRIBE`, the last removal issues `UNSUBSCRIBE`. Duplicate unsubscribe is
  a no-op.
- A dead or full local sender is removed while publishing. The last removal
  must release the Redis subscription.
- Reconnect the pub/sub connection with backoff and re-issue `SUBSCRIBE` for
  every topic that still has local senders. Messages may be lost during the
  gap; the browser reconnects and re-subscribes after its own socket closes.
- Decode a Redis payload with the `transit` crate. A malformed payload is
  logged and skipped; it must not stop the listener.

## Live integration tests

Gate the tests on `PENPOT_TEST_REDIS_URL` and mark them `#[ignore]` so the
offline workspace stays green.

1. Publish on `acme.file-1`; a subscriber opened for `file-1` receives the map
   once, with logical `:topic` equal to `file-1`.
2. Two local subscriptions to one topic produce one Redis `SUBSCRIBE`; removing
   the first keeps it open, removing the second closes it.
3. A second process (or a second connection acting as the remote side) can
   publish to the prefixed topic and reach the local sender.
4. A malformed payload does not stop later deliveries.
5. Kill and restart the pub/sub connection; subscribed topics are reopened and
   a later publish arrives.

## Browser flow

Run the Clojure backend and the Rust gateway against the same Redis and tenant,
then open two frontend tabs on one file:

1. Both sockets connect to `/ws/notifications?session-id=<uuid>`.
2. Each sends `subscribe-team` and `subscribe-file`; only the other tab sees
   `join-file`, then `presence`.
3. Pointer movement from one tab reaches the other with `subs-id`,
   `profile-id` and `session-id`.
4. Closing one tab produces `leave-file` or `disconnect`, followed by
   `presence`, in the other tab.
5. The 5-second ping keeps the socket open; three unanswered pings close it
   with code 8802.

## Out of scope

- Replacing the Clojure gateway in deployment.
- Redis Cluster topology, Sentinel failover and cross-region replication.
- Persisting notifications or replaying messages missed while disconnected.
