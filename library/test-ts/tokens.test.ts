// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

import assert from "node:assert/strict";
import test from "node:test";

import { TextWriter, Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";
import type { FileEntry } from "@zip.js/zip.js";

import { createBuildContext, exportAsBytes } from "../src-ts/index.ts";
import {
  HIDDEN_THEME_ID,
  HIDDEN_THEME_PATH,
  exportDtcgJson,
  getSets,
  getThemes,
  makeTokensLib,
  readMultiSetDtcg,
} from "../src-ts/tokens.ts";
import type { TokensLib } from "../src-ts/tokens.ts";

type Json = any;

const DTCG: Json = {
  $themes: [
    {
      id: "theme-1",
      name: "Light",
      description: "Light theme",
      isSource: true,
      selectedTokenSets: {
        core: "enabled",
        "brand/primary": "enabled",
        absent: "enabled",
      },
    },
  ],
  $metadata: {
    tokenSetOrder: ["core", "brand/primary"],
    activeThemes: ["/Light"],
    activeSets: ["core"],
  },
  core: {
    color: { $type: "color", $value: "#ffffff", $description: "Background" },
    spacing: { $value: "4px", $type: "dimension" },
    typography: {
      $type: "typography",
      $value: {
        fontFamily: "Inter, Arial",
        fontSize: "16px",
        fontWeight: "400",
        letterSpacing: "0px",
        lineHeight: "1.5",
        textCase: "none",
      },
    },
    shadow: {
      $type: "shadow",
      $value: [
        {
          offsetX: "0px",
          offsetY: "2px",
          blur: "4px",
          spread: "0px",
          color: "#000000",
          inset: "false",
        },
      ],
    },
  },
  "brand/primary": {
    brand: { $type: "color", $value: "#ff0000" },
    untyped: { $value: "kept out" },
  },
};

async function readTokensEntry(bytes: Uint8Array, name: string): Promise<Json> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    useWebWorkers: false,
  });
  const entries = await reader.getEntries();
  const entry = entries.find(
    (item) => !item.directory && item.filename === name,
  ) as FileEntry | undefined;
  assert.ok(entry, `missing zip entry ${name}`);
  const text = await entry.getData(new TextWriter());
  await reader.close();
  return JSON.parse(text);
}

function setByName(lib: TokensLib, name: string) {
  return getSets(lib).find((tokenSet) => tokenSet.name === name);
}

test("reads multi-set DTCG into sets, tokens and themes", () => {
  const lib = readMultiSetDtcg(DTCG);

  assert.deepEqual(
    getSets(lib).map((tokenSet) => tokenSet.name),
    ["core", "brand/primary"],
  );

  const core = setByName(lib, "core");
  assert.ok(core);
  assert.deepEqual(Object.keys(core.tokens), [
    "color",
    "spacing",
    "typography",
    "shadow",
  ]);

  const color = core.tokens.color;
  assert.equal(color.type, "color");
  assert.equal(color.value, "#ffffff");
  assert.equal(color.description, "Background");

  // The type declared on the token overrides the inherited group type.
  assert.equal(core.tokens.spacing.type, "dimensions");
  assert.equal(core.tokens.spacing.description, "");
  assert.match(core.tokens.spacing.id, /^[0-9a-f-]{36}$/);

  const brand = setByName(lib, "brand/primary");
  assert.ok(brand);
  // Untyped tokens cannot be given a type, so they are discarded.
  assert.deepEqual(Object.keys(brand.tokens), ["brand"]);

  const themes = getThemes(lib);
  assert.equal(themes.length, 2);
  assert.equal(themes[0]?.id, HIDDEN_THEME_ID);
  assert.deepEqual(themes[0]?.sets, ["core"]);

  const light = themes[1];
  assert.ok(light);
  assert.equal(light.name, "Light");
  assert.equal(light.externalId, "theme-1");
  assert.equal(light.isSource, true);
  // The reader drops the theme description, as the CLJS one does.
  assert.equal(light.description, "");
  // Sets that do not exist in the library are dropped.
  assert.deepEqual(light.sets, ["core", "brand/primary"]);

  // Activating a theme replaces the hidden theme in the active set.
  assert.deepEqual(lib.activeThemes, ["/Light"]);
});

test("converts typography, shadow and font-family values", () => {
  const core = setByName(readMultiSetDtcg(DTCG), "core");
  assert.ok(core);

  assert.deepEqual(core.tokens.typography.value, {
    "font-family": ["Inter", "Arial"],
    "font-size": "16px",
    "font-weight": "400",
    "letter-spacing": "0px",
    "line-height": "1.5",
    "text-case": "none",
  });

  assert.deepEqual(core.tokens.shadow.value, [
    {
      "offset-x": "0px",
      "offset-y": "2px",
      blur: "4px",
      spread: "0px",
      color: "#000000",
      inset: false,
    },
  ]);
});

test("inherits $type from the enclosing group", () => {
  const lib = readMultiSetDtcg({
    group: {
      outer: {
        $type: "fontFamilies",
        token: { $value: "Inter" },
      },
    },
    other: {
      outer: {
        $type: "fontFamilies",
        token: { $value: ["Inter", "Arial"] },
      },
    },
  });

  const first = setByName(lib, "group");
  const second = setByName(lib, "other");
  assert.ok(first);
  assert.ok(second);

  const firstToken = first.tokens["outer.token"];
  const secondToken = second.tokens["outer.token"];
  assert.ok(firstToken);
  assert.ok(secondToken);
  assert.equal(firstToken.type, "font-family");
  assert.deepEqual(firstToken.value, ["Inter"]);
  assert.deepEqual(secondToken.value, ["Inter", "Arial"]);
});

test("exports the same DTCG documents it reads", () => {
  const exported = exportDtcgJson(readMultiSetDtcg(DTCG)) as Json;

  assert.deepEqual(Object.keys(exported).sort(), [
    "$metadata",
    "$themes",
    "brand/primary",
    "core",
  ]);

  assert.deepEqual(exported.core.color, {
    $value: "#ffffff",
    $type: "color",
    $description: "Background",
  });
  assert.deepEqual(exported.core.typography.$value, {
    fontFamilies: ["Inter", "Arial"],
    fontSizes: "16px",
    fontWeights: "400",
    letterSpacing: "0px",
    lineHeights: "1.5",
    textCase: "none",
  });
  assert.deepEqual(exported.core.shadow.$value, [
    {
      offsetX: "0px",
      offsetY: "2px",
      blur: "4px",
      spread: "0px",
      color: "#000000",
      inset: false,
    },
  ]);

  assert.deepEqual(exported.$themes, [
    {
      id: "theme-1",
      name: "Light",
      group: "",
      description: "",
      isSource: true,
      selectedTokenSets: { core: "enabled", "brand/primary": "enabled" },
    },
  ]);
  assert.deepEqual(exported.$metadata, {
    tokenSetOrder: ["core", "brand/primary"],
    activeThemes: ["/Light"],
    activeSets: ["core", "brand/primary"],
  });
});

test("keeps the hidden theme active when no theme is declared", () => {
  const lib = readMultiSetDtcg({
    $metadata: { activeSets: ["core"] },
    core: { color: { $type: "color", $value: "#000000" } },
  });

  assert.deepEqual(lib.activeThemes, [HIDDEN_THEME_PATH]);

  const exported = exportDtcgJson(lib);
  assert.ok(exported);
  assert.deepEqual(exported.$themes, []);
  assert.deepEqual(exported.$metadata, {
    tokenSetOrder: ["core"],
    activeThemes: [],
    activeSets: ["core"],
  });
});

test("exports nothing for an empty library", () => {
  assert.equal(exportDtcgJson(makeTokensLib()), null);
});

test("reads a JSON string and accepts an existing library", () => {
  const lib = readMultiSetDtcg(JSON.stringify(DTCG));
  assert.equal(getSets(lib).length, 2);
  assert.equal(readMultiSetDtcg(lib), lib);
});

test("rejects data that is not a DTCG object", () => {
  assert.throws(() => readMultiSetDtcg(42), /plain object/);
  assert.throws(() => readMultiSetDtcg("{"), /valid json/);
  assert.throws(
    () => readMultiSetDtcg({ $themes: [{}] }),
    /valid theme/,
  );
  assert.throws(
    () => readMultiSetDtcg({ $metadata: { tokenSetOrder: "core" } }),
    /vector of strings/,
  );
  assert.throws(() => readMultiSetDtcg({ core: "text" }), /plain object/);
  assert.throws(
    () => readMultiSetDtcg({ $metadata: {} }),
    /doesn't contain any tokens/,
  );
});

test("writes tokens.json into the archive", async () => {
  const context = createBuildContext();
  const fileId = context.addFile({ name: "sample" });
  context.addTokensLib(DTCG);

  const state = context.getInternalState() as Json;
  assert.ok(state.files[fileId].data.tokensLib.sets);

  const tokens: Json = await readTokensEntry(
    await exportAsBytes(context),
    `files/${fileId}/tokens.json`,
  );

  const exportedTokens = exportDtcgJson(
    state.files[fileId].data.tokensLib as TokensLib,
  ) as Json;

  assert.deepEqual(tokens, exportedTokens);
  assert.deepEqual(tokens.core.color, {
    $value: "#ffffff",
    $type: "color",
    $description: "Background",
  });
  assert.deepEqual(tokens.$metadata.tokenSetOrder, [
    "core",
    "brand/primary",
  ]);
});
