---
title: Exporter app
desc: Learn about self-hosting, configuration, architecture (backend, frontend), data model, and development environment. See Penpot's technical guide.
---

# Exporter app

When exporting file contents, we want the result to look the same as the canvas.
The exporter runs a headless browser installed on the backend host and drives
it with Playwright. The browser loads the frontend app from the static
webserver and runs it like a normal user browser, visiting a special endpoint
that renders one shape inside a file. It takes a screenshot for bitmap exports,
or extracts the SVG from the DOM for vector exports, and writes the result to a
file the user can download.

## Exporter structure

Penpot exporter app code resides under <code class="language-text">exporter/src-ts/app</code> path in the main repository.

@startuml Exporter
!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml
!define DEVICONS https://raw.githubusercontent.com/tupadr3/plantuml-icon-font-sprites/master/devicons
!include DEVICONS/react.puml
!include DEVICONS/nodejs.puml
!include DEVICONS/chrome.puml

HIDE_STEREOTYPE()

Container(frontend_app, "Frontend app", "React / ClojureScript", "", "react")

System_Boundary(backend, "Backend") {
    Container(exporter, "Exporter", "TypeScript / Node.js", "", "nodejs")
    Container(browser, "Headless browser", "Chrome", "", "chrome")
}

Rel_D(frontend_app, exporter, "Uses", "HTTPS")
Rel_R(exporter, browser, "Uses", "puppeteer")
Rel_U(browser, frontend_app, "Uses", "HTTPS")

@enduml

```text
  ▾ exporter/src-ts/app/
    ▸ handlers/
    ▸ jobs/
    ▸ renderer/
    ▸ util/
    ▸ wasm/
      app.ts
      browser.ts
      config.ts
      core.ts
      http.ts
      router.ts
```

## Exporter modules

* **core** has the setup and run functions of the Node.js app.

* **http** and **router** expose a basic http server, with endpoints to export
  a shape or a file. The handlers live under **handlers/**.

* **browser** controls a local Chromium browser via
  [Playwright](https://playwright.dev).

* **renderer** renders an object in the browser and makes a screenshot, then
  converts it to bitmap, pdf or svg as needed. **wasm/** holds the headless
  render path, its worker pool and the transit serializers.

* **jobs** admits, stores and schedules exports; the job records live in Redis.

* **config** gets configuration settings from the linux environment.

* **util** has some generic utility functions.
