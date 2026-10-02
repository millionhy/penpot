"use client";

// Auth route group container. Port of app.main.ui.auth/auth*: the logo header,
// the registration illustration (hidden on the register variants), the content
// column, the terms footer that only the register page gets, the html title,
// and the ?error= banner for OIDC redirect failures.

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useNotifications } from "@/components/notifications";
import { oidcRedirectError } from "@/lib/auth";
import { config } from "@/lib/config";
import { tr } from "@/lib/i18n";
import { routePaths } from "@/lib/routes";

const registerPaths: ReadonlySet<string> = new Set([
  routePaths["auth-register"],
  routePaths["auth-register-validate"],
  routePaths["auth-register-success"],
]);

// terms-service-privacy-policy* in app.main.ui.auth.register.
function TermsFooter() {
  const terms = config.termsOfServiceUri;
  const privacy = config.privacyPolicyUri;
  if (terms === null || privacy === null) return null;
  return (
    <div className="auth-terms">
      <a className="auth-terms-link" href={terms} target="_blank" rel="noreferrer noopener">
        {tr("auth.terms-of-service")}
      </a>
      <span className="auth-terms-and">{` ${tr("labels.and")} `}</span>
      <a className="auth-terms-link" href={privacy} target="_blank" rel="noreferrer noopener">
        {tr("auth.privacy-policy")}
      </a>
    </div>
  );
}

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { warn } = useNotifications();
  const isRegister = registerPaths.has(pathname);

  useEffect(() => {
    document.title = tr("title.default");
  }, []);

  // show-redirect-error, emitted by auth* from the ?error= query parameter.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const message = oidcRedirectError(params.get("error"));
    if (message !== null) warn(message);
  }, [warn, pathname]);

  return (
    <main className={isRegister ? "auth-section auth-section-register" : "auth-section"}>
      <h1 className="auth-logo-container">
        <Link href="/" title="Penpot" aria-label="Penpot">
          <img className="auth-logo" src="/images/penpot-logo.svg" alt="Penpot" />
        </Link>
      </h1>

      <div className="auth-illustration">
        <img src="/images/registration-illustration.png" alt="" />
      </div>

      <section className="auth-content">
        {children}
        {pathname === routePaths["auth-register"] ? <TermsFooter /> : null}
      </section>
    </main>
  );
}
