// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// The builder state is private to `api.ts`, but the exporter reads it
// directly: in the CLJS code `createBuildContext` returned an object that
// also implemented `IDeref`, so `lib.export` could deref it. A symbol key
// keeps that channel without adding a method to the public surface.

export const RAW_STATE: unique symbol = Symbol("penpot.builder.state");
