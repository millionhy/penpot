"use client";

// Port of app.main.ui.auth.register/register-success-page*: the "check your
// email" screen shown after register-profile sent the verification email. The
// address comes from the query string or, when the user arrived by navigation,
// from the penpot-user storage entry the register form wrote.

import { useEffect, useState } from "react";
import { QueryParams } from "@/components/query-params";
import { tr } from "@/lib/i18n";
import { REGISTER_NS, userStorage } from "@/lib/storage";

function SuccessContent({ params }: { params: URLSearchParams }) {
  const [email, setEmail] = useState<string | null>(params.get("email"));

  useEffect(() => {
    if (email !== null) return;
    const stored = userStorage.get<string>(REGISTER_NS, "email");
    if (typeof stored === "string" && stored.length > 0) setEmail(stored);
  }, [email]);

  return (
    <div className="auth-wrapper auth-wrapper-success">
      <div className="auth-title-wrapper">
        <h2 className="auth-title">{tr("auth.check-email")}</h2>
        <div className="auth-notification-text">{tr("auth.verification-sent-email")}</div>
      </div>
      <div className="auth-notification-email">{email}</div>
    </div>
  );
}

export default function RegisterSuccessPage() {
  return (
    <QueryParams>
      {(params) => <SuccessContent params={params} key={params.toString()} />}
    </QueryParams>
  );
}
