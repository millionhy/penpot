import { describe, expect, it } from "vitest";
import {
  classifyVerifyToken,
  classifyVerifyTokenError,
  loginError,
  oidcRedirectError,
  recoveryError,
  recoveryRequestError,
  registerFieldError,
} from "@/lib/auth";
import { RpcError } from "@/lib/errors";
import { tr } from "@/lib/i18n";

function rpc(type: string, code?: string, extra: Record<string, unknown> = {}) {
  return new RpcError("http error", { type, code, ...extra });
}

describe("classifyVerifyToken", () => {
  it("logs in on a verify-email token", () => {
    expect(classifyVerifyToken({ iss: "verify-email", "profile-id": "p1" })).toEqual({
      kind: "logged-in",
      iss: "verify-email",
      invitationToken: undefined,
    });
  });

  it("carries the invitation token embedded in a verify-email token", () => {
    const outcome = classifyVerifyToken({ iss: "verify-email", "invitation-token": "inv" });
    expect(outcome).toEqual({ kind: "logged-in", iss: "verify-email", invitationToken: "inv" });
  });

  it("logs in on an auth token", () => {
    expect(classifyVerifyToken({ iss: "auth" }).kind).toBe("logged-in");
  });

  it("routes a change-email token to the profile settings", () => {
    expect(classifyVerifyToken({ iss: "change-email" })).toEqual({ kind: "email-changed" });
  });

  it("prefers the organization team on an accepted organization invitation", () => {
    expect(
      classifyVerifyToken({
        iss: "team-invitation",
        state: "created",
        "team-id": "t1",
        "organization-team-id": "o1",
        "organization-name": "Acme",
      }),
    ).toEqual({ kind: "invitation-accepted", teamId: "o1", organizationName: "Acme" });
  });

  it("uses the team id on an accepted team invitation", () => {
    expect(
      classifyVerifyToken({ iss: "team-invitation", state: "created", "team-id": "t1" }),
    ).toEqual({ kind: "invitation-accepted", teamId: "t1", organizationName: undefined });
  });

  it("sends a pending invitation to the redirect route with its token", () => {
    expect(
      classifyVerifyToken({
        iss: "team-invitation",
        state: "pending",
        "redirect-to": "auth-login",
        "invitation-token": "inv",
      }),
    ).toEqual({ kind: "invitation-pending", route: "auth-login", invitationToken: "inv" });
  });

  it("falls back to the register route for a pending invitation", () => {
    expect(classifyVerifyToken({ iss: "team-invitation", state: "pending" })).toEqual({
      kind: "invitation-pending",
      route: "auth-register",
      invitationToken: undefined,
    });
  });

  it("rejects an unknown issuer", () => {
    expect(classifyVerifyToken({ iss: "something-else" })).toEqual({
      kind: "invalid",
      reason: "invalid-token",
    });
  });
});

describe("classifyVerifyTokenError", () => {
  it("keeps the team id when the member already belongs to it", () => {
    expect(classifyVerifyTokenError(rpc("validation", "invalid-token-already-member", { "team-id": "t1" }))).toEqual({
      kind: "already-member",
      teamId: "t1",
    });
  });

  it("reports a missing organization", () => {
    expect(classifyVerifyTokenError(rpc("not-found", "organization-not-found", { "team-id": "t1" }))).toEqual({
      kind: "organization-not-found",
      teamId: "t1",
    });
  });

  it("reports a canceled invitation", () => {
    expect(classifyVerifyTokenError(rpc("validation", "canceled-invitation"))).toEqual({
      kind: "canceled-invitation",
    });
  });

  it("distinguishes an expired token", () => {
    expect(classifyVerifyTokenError(rpc("validation", "invalid-token", { reason: "token-expired" }))).toEqual({
      kind: "invalid",
      reason: "token-expired",
    });
  });

  it("distinguishes an invitation email mismatch", () => {
    expect(classifyVerifyTokenError(rpc("validation", "x", { reason: "email-mismatch" }))).toEqual({
      kind: "invalid",
      reason: "email-mismatch",
    });
  });

  // The CLJS cond tests :validation type before the email-already-exists code,
  // so a validation error always lands on the invalid-token card.
  it("reports a validation error as an invalid token", () => {
    expect(classifyVerifyTokenError(rpc("validation", "email-already-exists"))).toEqual({
      kind: "invalid",
      reason: "invalid-token",
    });
  });

  it("reports an already validated email outside the validation type", () => {
    expect(classifyVerifyTokenError(rpc("restriction", "email-already-validated"))).toEqual({
      kind: "email-already-validated",
    });
  });

  it("falls back to the generic error for anything else", () => {
    expect(classifyVerifyTokenError(rpc("internal", "boom"))).toEqual({ kind: "error" });
    expect(classifyVerifyTokenError(new Error("network down"))).toEqual({ kind: "error" });
  });
});

describe("loginError", () => {
  it("reports wrong credentials in the form banner", () => {
    expect(loginError(rpc("validation", "wrong-credentials"))).toEqual({
      kind: "banner",
      message: tr("errors.wrong-credentials"),
    });
  });

  it("treats an account without a password as wrong credentials", () => {
    expect(loginError(rpc("validation", "account-without-password"))).toEqual({
      kind: "banner",
      message: tr("errors.wrong-credentials"),
    });
  });

  it("reports a blocked profile", () => {
    expect(loginError(rpc("restriction", "profile-blocked"))).toEqual({
      kind: "banner",
      message: tr("errors.profile-blocked"),
    });
  });

  it("sends the ldap failure to the toast channel", () => {
    expect(loginError(rpc("restriction", "ldap-not-initialized"))).toEqual({
      kind: "toast",
      message: tr("errors.ldap-disabled"),
    });
  });

  it("rounds the lock ttl up to whole minutes", () => {
    expect(loginError(rpc("rate-limit", "account-locked", { ttl: 61 }))).toEqual({
      kind: "banner",
      message: tr("errors.account-locked", 2),
    });
  });

  it("never locks for less than a minute", () => {
    expect(loginError(rpc("rate-limit", "account-locked", { ttl: 0 })).message).toBe(
      tr("errors.account-locked", 1),
    );
  });

  it("falls back to the generic message", () => {
    expect(loginError(rpc("internal", "boom"))).toEqual({
      kind: "banner",
      message: tr("errors.generic"),
    });
    expect(loginError(new Error("offline"))).toEqual({
      kind: "banner",
      message: tr("errors.generic"),
    });
  });
});

describe("registerFieldError", () => {
  it("marks the email field for a duplicate address", () => {
    expect(registerFieldError(rpc("validation", "email-already-exists"))).toEqual({
      field: "email",
      message: tr("errors.email-already-exists"),
    });
  });

  it("marks the password field when it equals the email", () => {
    expect(registerFieldError(rpc("validation", "email-as-password"))).toEqual({
      field: "password",
      message: tr("errors.email-as-password"),
    });
  });

  it("translates the weak password reasons sent by the backend", () => {
    const mapped = registerFieldError(
      rpc("validation", "weak-password", { details: ["errors.weak-password.too-short"] }),
    );
    expect(mapped?.field).toBe("password");
    expect(mapped?.message).toBe(tr("errors.weak-password.too-short"));
  });

  it("interpolates the address into the bounce report", () => {
    expect(
      registerFieldError(
        rpc("restriction", "email-has-permanent-bounces", { email: "ada@example.com" }),
      ),
    ).toEqual({
      field: "email",
      message: tr("errors.email-has-permanent-bounces", "ada@example.com"),
    });
  });

  it("returns null so the caller can fall back to the generic toast", () => {
    expect(registerFieldError(rpc("internal", "boom"))).toBeNull();
    expect(registerFieldError(new Error("x"))).toBeNull();
  });
});

describe("recoveryError", () => {
  it("reports a weak password on the field", () => {
    expect(recoveryError(rpc("validation", "weak-password", { details: [] }))).toEqual({
      field: "password-1",
      message: tr("errors.weak-password"),
    });
  });

  it("treats anything else as an unusable token", () => {
    expect(recoveryError(rpc("validation", "invalid-token"))).toBe("invalid-token");
    expect(recoveryError(new Error("x"))).toBe("invalid-token");
  });
});

describe("recoveryRequestError", () => {
  it("reports an unverified profile", () => {
    expect(recoveryRequestError(rpc("validation", "profile-not-verified"), "a@b.com")).toBe(
      tr("auth.notifications.profile-not-verified"),
    );
  });

  it("reports a muted profile", () => {
    expect(recoveryRequestError(rpc("restriction", "profile-is-muted"), "a@b.com")).toBe(
      tr("errors.profile-is-muted"),
    );
  });

  it("interpolates the address into the bounce report", () => {
    expect(recoveryRequestError(rpc("restriction", "email-has-complaints"), "a@b.com")).toBe(
      tr("errors.email-has-permanent-bounces", "a@b.com"),
    );
  });

  it("falls back to the generic message", () => {
    expect(recoveryRequestError(rpc("internal", "boom"), "a@b.com")).toBe(tr("errors.generic"));
  });

  it("returns null for a non rpc failure", () => {
    expect(recoveryRequestError(new Error("offline"), "a@b.com")).toBeNull();
  });
});

describe("oidcRedirectError", () => {
  it("maps the known redirect failures", () => {
    expect(oidcRedirectError("registration-disabled")).toBe(tr("errors.registration-disabled"));
    expect(oidcRedirectError("profile-blocked")).toBe(tr("errors.profile-blocked"));
    expect(oidcRedirectError("auth-provider-not-allowed")).toBe(
      tr("errors.auth-provider-not-allowed"),
    );
    expect(oidcRedirectError("email-domain-not-allowed")).toBe(
      tr("errors.email-domain-not-allowed"),
    );
  });

  it("stays silent when the user canceled", () => {
    expect(oidcRedirectError("unable-to-auth")).toBeNull();
  });

  it("reports anything else generically", () => {
    expect(oidcRedirectError("whatever")).toBe(tr("errors.generic"));
  });

  it("stays silent without a parameter", () => {
    expect(oidcRedirectError(null)).toBeNull();
    expect(oidcRedirectError("")).toBeNull();
  });
});
