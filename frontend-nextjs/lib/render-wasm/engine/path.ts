// Engine-facing aliases for the common path mirror.
//
// The bounds slice needs the packed-content reader and the open-path test.
// Both now live in lib/common/path so the engine and the canvas path tools
// use one implementation.

export {
  pathSegments,
  shapeWithOpenPath,
  type PathSegment as PathSegmentLike,
} from "@/lib/common/path";
