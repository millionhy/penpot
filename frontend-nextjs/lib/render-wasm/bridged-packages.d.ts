// Ambient declarations for the bridged packages that ship no type
// declarations. The registry in packages.ts only hands these modules through
// to the compiled renderer (the real readers are the CLJS namespaces inside
// shared.js), so the modules stay untyped on purpose and nothing in the shell
// dereferences them.
declare module "@penpot/svgo";
declare module "@penpot/ua-parser";
declare module "js-beautify";
declare module "lodash/debounce.js";
declare module "sax";
declare module "tdigest";
declare module "tinycolor2";
