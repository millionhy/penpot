import { describe, expect, it } from "vitest";
import {
  cleanValues,
  passwordMinLength,
  validateAll,
  validateField,
  type FieldSpec,
  type FieldSpecs,
} from "@/lib/forms";
import { tr } from "@/lib/i18n";

const text: FieldSpec = { type: "text", max: 250 };
const optionalText: FieldSpec = { type: "text", optional: true };
const email: FieldSpec = { type: "email" };
const optionalEmail: FieldSpec = { type: "email", optional: true };
const password: FieldSpec = { type: "password" };
const terms: FieldSpec = { type: "checkbox", mustBeTrue: true };
const newsletter: FieldSpec = { type: "checkbox", optional: true };

describe("validateField text", () => {
  it("accepts a non blank value", () => {
    expect(validateField(text, "Ada Lovelace")).toBeNull();
  });

  it("reports an empty required value as missing", () => {
    expect(validateField(text, "")).toBe(tr("errors.field-missing"));
  });

  it("reports a whitespace only value", () => {
    expect(validateField(text, "   ")).toBe(tr("errors.field-not-all-whitespace"));
  });

  it("enforces the max length", () => {
    expect(validateField(text, "a".repeat(251))).toBe(tr("errors.field-max-length", 250));
  });

  it("treats an empty optional value as absent", () => {
    expect(validateField(optionalText, "")).toBeNull();
  });
});

describe("validateField email", () => {
  it("accepts the schema email shape", () => {
    expect(validateField(email, "ada@example.com")).toBeNull();
  });

  it("rejects an address without a tld", () => {
    expect(validateField(email, "ada@example")).toBe(tr("errors.invalid-email"));
  });

  it("reports an empty required address as invalid email, like ::sm/email", () => {
    expect(validateField(email, "")).toBe(tr("errors.invalid-email"));
  });

  it("treats an empty optional address as absent", () => {
    expect(validateField(optionalEmail, "")).toBeNull();
  });
});

describe("validateField password", () => {
  it("rejects anything shorter than the minimum", () => {
    expect(validateField(password, "a".repeat(passwordMinLength - 1))).toBe(
      tr("errors.password-too-short"),
    );
  });

  it("accepts the minimum length", () => {
    expect(validateField(password, "a".repeat(passwordMinLength))).toBeNull();
  });
});

describe("validateField checkbox", () => {
  it("requires an accepted terms box", () => {
    expect(validateField(terms, false)).toBe(tr("errors.invalid-data"));
    expect(validateField(terms, true)).toBeNull();
  });

  it("accepts an unchecked optional box", () => {
    expect(validateField(newsletter, false)).toBeNull();
  });
});

describe("validateAll", () => {
  const specs: FieldSpecs = {
    token: { type: "text" },
    "password-1": password,
    "password-2": password,
  };
  const confirmation = {
    field: "password-2",
    message: tr("errors.password-invalid-confirmation"),
    check: (values: Record<string, string | boolean>) =>
      values["password-1"] === values["password-2"],
  };

  it("reports every invalid field", () => {
    const errors = validateAll(specs, { token: "", "password-1": "", "password-2": "" }, [
      confirmation,
    ]);
    expect(Object.keys(errors).sort()).toEqual(["password-1", "password-2", "token"]);
  });

  it("applies the form level constraint when the fields are valid", () => {
    const errors = validateAll(
      specs,
      { token: "t", "password-1": "longenough", "password-2": "otherlong" },
      [confirmation],
    );
    expect(errors).toEqual({ "password-2": tr("errors.password-invalid-confirmation") });
  });

  it("returns no error for a valid form", () => {
    expect(
      validateAll(
        specs,
        { token: "t", "password-1": "longenough", "password-2": "longenough" },
        [confirmation],
      ),
    ).toEqual({});
  });
});

describe("cleanValues", () => {
  const specs: FieldSpecs = {
    fullname: text,
    email,
    "accept-newsletter-updates": newsletter,
    "invitation-token": optionalText,
  };

  it("drops empty optional values and normalizes checkboxes", () => {
    expect(
      cleanValues(specs, {
        fullname: "Ada",
        email: "ada@example.com",
        "accept-newsletter-updates": true,
        "invitation-token": "",
      }),
    ).toEqual({
      fullname: "Ada",
      email: "ada@example.com",
      "accept-newsletter-updates": true,
    });
  });

  it("keeps an empty required value so the backend sees the key", () => {
    expect(cleanValues({ email }, { email: "" })).toEqual({ email: "" });
  });
});

const autoLocale: FieldSpec = { type: "select", optional: true, max: 20 };
const themeSelect: FieldSpec = {
  type: "select",
  optional: true,
  max: 250,
  oneOf: ["light", "dark", "system"],
};
const feedbackType: FieldSpec = { type: "select", oneOf: ["idea", "issue", "doubt"] };
const notifyGroup: FieldSpec = { type: "radio", oneOf: ["all", "partial", "none"] };
const feedbackBody: FieldSpec = { type: "textarea", max: 5000 };
const optionalBody: FieldSpec = { type: "textarea", optional: true, max: 5000 };

describe("validateField select", () => {
  it("accepts a listed option", () => {
    expect(validateField(themeSelect, "light")).toBeNull();
  });

  it("accepts the browser detect option on an optional select", () => {
    expect(validateField(autoLocale, "")).toBeNull();
  });

  it("reports an unlisted option as invalid data", () => {
    expect(validateField(themeSelect, "solarized")).toBe(tr("errors.invalid-data"));
  });

  it("reports the membership failure before the length failure", () => {
    expect(validateField(themeSelect, "a".repeat(251))).toBe(tr("errors.invalid-data"));
  });

  it("enforces the max length on a select without a closed option list", () => {
    expect(validateField(autoLocale, "a".repeat(21))).toBe(
      tr("errors.field-max-length", 20),
    );
  });

  it("reports an empty required select as missing", () => {
    expect(validateField(feedbackType, "")).toBe(tr("errors.field-missing"));
  });
});

describe("validateField radio", () => {
  it("accepts the chosen option", () => {
    expect(validateField(notifyGroup, "partial")).toBeNull();
  });

  it("reports a value outside the group", () => {
    expect(validateField(notifyGroup, "some")).toBe(tr("errors.invalid-data"));
  });

  it("reports an unanswered required group", () => {
    expect(validateField(notifyGroup, "")).toBe(tr("errors.field-missing"));
  });
});

describe("validateField textarea", () => {
  it("accepts the body text", () => {
    expect(validateField(feedbackBody, "Rulers would help me align frames.")).toBeNull();
  });

  it("reports an empty required body as missing", () => {
    expect(validateField(feedbackBody, "")).toBe(tr("errors.field-missing"));
  });

  it("reports a whitespace only body", () => {
    expect(validateField(feedbackBody, "   ")).toBe(
      tr("errors.field-not-all-whitespace"),
    );
  });

  it("enforces the max length", () => {
    expect(validateField(feedbackBody, "a".repeat(5001))).toBe(
      tr("errors.field-max-length", 5000),
    );
  });

  it("treats an empty optional body as absent", () => {
    expect(validateField(optionalBody, "")).toBeNull();
    expect(validateField(optionalBody, "   ")).toBeNull();
  });
});

describe("cleanValues select and radio", () => {
  const specs: FieldSpecs = {
    lang: autoLocale,
    theme: themeSelect,
    "notify-team-invitation": notifyGroup,
    content: feedbackBody,
  };

  it("keeps the empty browser detect locale", () => {
    expect(cleanValues({ lang: autoLocale }, { lang: "" })).toEqual({ lang: "" });
  });

  it("keeps every definite choice", () => {
    expect(
      cleanValues(specs, {
        lang: "es",
        theme: "light",
        "notify-team-invitation": "all",
        content: "Thanks",
      }),
    ).toEqual({
      lang: "es",
      theme: "light",
      "notify-team-invitation": "all",
      content: "Thanks",
    });
  });

  it("keeps an unanswered radio group so the schema error is not hidden", () => {
    expect(cleanValues({ theme: themeSelect }, { theme: "" })).toEqual({ theme: "" });
  });
});
