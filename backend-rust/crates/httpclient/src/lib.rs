//! Outbound HTTP for the backend, mirroring `app.util.ssrf` and
//! `app.http.client`.
//!
//! Every webhook URI is user input, so the client resolves the host once,
//! rejects the request when **any** address falls in a blocked range, and then
//! pins the validated addresses for the connection. Pinning closes the DNS
//! rebinding window that the Clojure client leaves open between
//! `validate-uri` and `java.net.http.HttpClient`'s own lookup.
//!
//! The HTTP transport is a trait so tests can replace it with a fake. The
//! PostgreSQL adapter never opens a socket on its own.

pub mod ssrf;
pub mod transport;

pub use ssrf::{blocks, SsrfBlocked, SsrfPolicy};
pub use transport::{HttpRequest, HttpResponse, ReqwestTransport, Transport, TransportError};
