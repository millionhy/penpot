// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// The build passes the package version through esbuild's define
// (`__PENPOT_LIBRARY_VERSION__`). Code run straight from the sources, such as
// the unit tests, falls back to this placeholder version.
declare const __PENPOT_LIBRARY_VERSION__: string | undefined;

export const LIBRARY_VERSION: string =
  typeof __PENPOT_LIBRARY_VERSION__ === "undefined"
    ? "0.0.0-test"
    : __PENPOT_LIBRARY_VERSION__;
