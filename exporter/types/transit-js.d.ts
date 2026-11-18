// transit-js ships without bundled types. The exporter only builds the codec
// surface it uses: readers, writers and the scalar constructors.
declare module "transit-js" {
  const transit: any;
  export default transit;
}