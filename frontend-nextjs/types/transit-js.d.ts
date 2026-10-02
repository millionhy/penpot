declare module "transit-js" {
  // transit-js ships without bundled types. The full codec (custom handlers for
  // uuid/instant/keyword namespaces from common/src/app/common/transit.cljc) is a
  // Phase-F task; the scaffold only needs the reader/writer/keyword/map surface.
  const transit: any;
  export default transit;
}