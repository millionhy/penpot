// The pen-logo loader (ds/product/loader): the pen logo with the pencil
// line animating over it, shown while a route-level fetch runs. The viewer
// page (F6.2) held the first port; F9.1 moved it here so the workspace
// route shares it.
import { tr } from "@/lib/i18n";

export function PenpotLoader() {
  return (
    <div className="pp-viewer-loader">
      <div className="pp-loader-content">
        <svg
          viewBox="0 0 677.34762 182.15429"
          role="status"
          width={100}
          height={27}
          className="pp-loader"
        >
          <title>{tr("labels.loading")}</title>
          <g>
            <path d="M128.273 0l-3.9 2.77L0 91.078l128.273 91.076 549.075-.006V.008L128.273 0zm20.852 30l498.223.006V152.15l-498.223.007V30zm-25 9.74v102.678l-49.033-34.813-.578-32.64 49.61-35.225z" />
            <path
              className="pp-loader-line"
              d="M134.482 157.147v25l518.57.008.002-25-518.572-.008z"
            />
          </g>
        </svg>
      </div>
    </div>
  );
}
