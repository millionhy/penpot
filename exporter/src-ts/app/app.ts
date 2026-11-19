// The bundle entry point, the same file render workers are spawned with.
// `installProcessHandlers` comes first so a crash during boot is reported, not
// swallowed.

import { installProcessHandlers, main } from "./core.js";

installProcessHandlers();
void main();