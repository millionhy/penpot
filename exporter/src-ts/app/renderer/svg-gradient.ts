// app.renderer.svg-gradient: builds the <linearGradient>/<radialGradient>
// definitions that the traced svg layers reference by id.
//
// The shape of the data comes from the page datasets: a mapping entry keyed by
// `#rrggbb` whose value is `{type: "linear" | "radial", gradient: {stops: [...]}}`.

export interface XmlNode {
  type: string;
  name: string;
  attributes?: Record<string, string>;
  elements?: XmlNode[];
}

interface StopData {
  offset: string | number;
  color: string;
  opacity: string | number;
}

interface GradientData {
  type: string;
  gradient: { type: string; stops: StopData[] };
}

function getStops(data: GradientData): XmlNode[] {
  return (data.gradient.stops ?? []).map((stop) => ({
    type: "element",
    name: "stop",
    attributes: {
      offset: String(stop.offset),
      "stop-color": stop.color,
      "stop-opacity": String(stop.opacity),
    },
  }));
}

export function dataToGradientDef(
  id: string,
  [color, data]: [string, GradientData],
): XmlNode {
  const gradientId = `gradient-${id}-${color.slice(1)}`;
  const gradientType = data.gradient.type;

  if (gradientType === "linear") {
    return {
      type: "element",
      name: "linearGradient",
      attributes: { id: gradientId, x1: "0.5", y1: "1", x2: "0.5", y2: "0" },
      elements: getStops(data),
    };
  }

  return {
    type: "element",
    name: "radialGradient",
    attributes: { id: gradientId, cx: "0.5", cy: "0.5", r: "0.5" },
    elements: getStops(data),
  };
}