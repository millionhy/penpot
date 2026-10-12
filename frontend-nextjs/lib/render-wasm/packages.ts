// The JS modules the compiled renderer (public/js/shared.js) pulls through the
// `shadow$bridge` global. shadow-cljs compiles every `:js-package-deps` import
// to a `shadow$bridge("<name>")` call that the host page must answer with the
// module namespace; the real frontend answers it from libs.js (esbuild bundle
// of the generated target/index.js), the shell answers it from here.
//
// The keys below are the 60 bridge call arguments extracted verbatim from the
// compiled artifacts — 58 fire at shared.js module init and 2 in the main.js
// entry chunk (app.main, which registers the transit handlers). Each is read
// either as `.default` (CJS package or ESM default export) or as named
// exports. `import * as` namespaces expose both, so no key may be renamed.
//
// This module is imported dynamically by bridge.ts at load time (browser
// only): it must stay free of side effects and of window/global access so it
// never evaluates during SSR.

import * as penpotDraftJs from "@penpot/draft-js";
import * as penpotMousetrap from "@penpot/mousetrap";
import * as penpotPluginsRuntime from "@penpot/plugins-runtime";
import * as penpotSvgo from "@penpot/svgo";
import * as penpotTextEditor from "@penpot/text-editor";
import * as penpotTokenscript from "@penpot/tokenscript";
import * as penpotUaParser from "@penpot/ua-parser";
import * as tokensStudioSdTransforms from "@tokens-studio/sd-transforms";
import * as dateFnsAdd from "date-fns/add";
import * as dateFnsDifferenceInMilliseconds from "date-fns/differenceInMilliseconds";
import * as dateFnsFormat from "date-fns/format";
import * as dateFnsFormatDistanceToNowStrict from "date-fns/formatDistanceToNowStrict";
import * as dateFnsFormatIso from "date-fns/formatISO";
import * as dateFnsLocaleArSa from "date-fns/locale/ar-SA";
import * as dateFnsLocaleCa from "date-fns/locale/ca";
import * as dateFnsLocaleCs from "date-fns/locale/cs";
import * as dateFnsLocaleDe from "date-fns/locale/de";
import * as dateFnsLocaleEl from "date-fns/locale/el";
import * as dateFnsLocaleEnUs from "date-fns/locale/en-US";
import * as dateFnsLocaleEs from "date-fns/locale/es";
import * as dateFnsLocaleEu from "date-fns/locale/eu";
import * as dateFnsLocaleFaIr from "date-fns/locale/fa-IR";
import * as dateFnsLocaleFr from "date-fns/locale/fr";
import * as dateFnsLocaleFrCa from "date-fns/locale/fr-CA";
import * as dateFnsLocaleGl from "date-fns/locale/gl";
import * as dateFnsLocaleHe from "date-fns/locale/he";
import * as dateFnsLocaleHr from "date-fns/locale/hr";
import * as dateFnsLocaleId from "date-fns/locale/id";
import * as dateFnsLocaleIt from "date-fns/locale/it";
import * as dateFnsLocaleJa from "date-fns/locale/ja";
import * as dateFnsLocaleKo from "date-fns/locale/ko";
import * as dateFnsLocaleLv from "date-fns/locale/lv";
import * as dateFnsLocaleNb from "date-fns/locale/nb";
import * as dateFnsLocaleNl from "date-fns/locale/nl";
import * as dateFnsLocalePl from "date-fns/locale/pl";
import * as dateFnsLocalePt from "date-fns/locale/pt";
import * as dateFnsLocalePtBr from "date-fns/locale/pt-BR";
import * as dateFnsLocaleRo from "date-fns/locale/ro";
import * as dateFnsLocaleRu from "date-fns/locale/ru";
import * as dateFnsLocaleTr from "date-fns/locale/tr";
import * as dateFnsLocaleUk from "date-fns/locale/uk";
import * as dateFnsLocaleZhCn from "date-fns/locale/zh-CN";
import * as dateFnsParseIso from "date-fns/parseISO";
import * as dateFnsSetDefaultOptions from "date-fns/setDefaultOptions";
import * as dateFnsSub from "date-fns/sub";
import * as eventsourceParserStream from "eventsource-parser/stream";
import * as jsBeautify from "js-beautify";
import * as lodashDebounce from "lodash/debounce.js";
import * as opentypeJs from "opentype.js";
import * as react from "react";
import * as reactDom from "react-dom";
import * as reactDomClient from "react-dom/client";
import * as reactDomServer from "react-dom/server";
import * as reactErrorBoundary from "react-error-boundary";
import * as reactJsxRuntime from "react/jsx-runtime";
import * as rxjs from "rxjs";
import * as sax from "sax";
import * as styleDictionary from "style-dictionary";
import * as tdigest from "tdigest";
import * as tinycolor2 from "tinycolor2";

export const bridgedModules: Record<string, unknown> = {
  "@penpot/draft-js": penpotDraftJs,
  "@penpot/mousetrap": penpotMousetrap,
  "@penpot/plugins-runtime": penpotPluginsRuntime,
  "@penpot/svgo": penpotSvgo,
  "@penpot/text-editor": penpotTextEditor,
  "@penpot/tokenscript": penpotTokenscript,
  "@penpot/ua-parser": penpotUaParser,
  "@tokens-studio/sd-transforms": tokensStudioSdTransforms,
  "date-fns/add": dateFnsAdd,
  "date-fns/differenceInMilliseconds": dateFnsDifferenceInMilliseconds,
  "date-fns/format": dateFnsFormat,
  "date-fns/formatDistanceToNowStrict": dateFnsFormatDistanceToNowStrict,
  "date-fns/formatISO": dateFnsFormatIso,
  "date-fns/locale/ar-SA": dateFnsLocaleArSa,
  "date-fns/locale/ca": dateFnsLocaleCa,
  "date-fns/locale/cs": dateFnsLocaleCs,
  "date-fns/locale/de": dateFnsLocaleDe,
  "date-fns/locale/el": dateFnsLocaleEl,
  "date-fns/locale/en-US": dateFnsLocaleEnUs,
  "date-fns/locale/es": dateFnsLocaleEs,
  "date-fns/locale/eu": dateFnsLocaleEu,
  "date-fns/locale/fa-IR": dateFnsLocaleFaIr,
  "date-fns/locale/fr": dateFnsLocaleFr,
  "date-fns/locale/fr-CA": dateFnsLocaleFrCa,
  "date-fns/locale/gl": dateFnsLocaleGl,
  "date-fns/locale/he": dateFnsLocaleHe,
  "date-fns/locale/hr": dateFnsLocaleHr,
  "date-fns/locale/id": dateFnsLocaleId,
  "date-fns/locale/it": dateFnsLocaleIt,
  "date-fns/locale/ja": dateFnsLocaleJa,
  "date-fns/locale/ko": dateFnsLocaleKo,
  "date-fns/locale/lv": dateFnsLocaleLv,
  "date-fns/locale/nb": dateFnsLocaleNb,
  "date-fns/locale/nl": dateFnsLocaleNl,
  "date-fns/locale/pl": dateFnsLocalePl,
  "date-fns/locale/pt": dateFnsLocalePt,
  "date-fns/locale/pt-BR": dateFnsLocalePtBr,
  "date-fns/locale/ro": dateFnsLocaleRo,
  "date-fns/locale/ru": dateFnsLocaleRu,
  "date-fns/locale/tr": dateFnsLocaleTr,
  "date-fns/locale/uk": dateFnsLocaleUk,
  "date-fns/locale/zh-CN": dateFnsLocaleZhCn,
  "date-fns/parseISO": dateFnsParseIso,
  "date-fns/setDefaultOptions": dateFnsSetDefaultOptions,
  "date-fns/sub": dateFnsSub,
  "eventsource-parser/stream": eventsourceParserStream,
  "js-beautify": jsBeautify,
  "lodash/debounce.js": lodashDebounce,
  "opentype.js": opentypeJs,
  react: react,
  "react-dom": reactDom,
  "react-dom/client": reactDomClient,
  "react-dom/server": reactDomServer,
  "react-error-boundary": reactErrorBoundary,
  "react/jsx-runtime": reactJsxRuntime,
  rxjs: rxjs,
  sax: sax,
  "style-dictionary": styleDictionary,
  tdigest: tdigest,
  tinycolor2: tinycolor2,
};
