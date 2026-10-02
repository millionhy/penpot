// Headless form state for the shell: the subset of app.util.forms the migrated
// pages need. The visual fields live in components/form.tsx.
//
// Validation mirrors the malli schemas the CLJS forms declare, including the
// messages chosen by interpret-schema-problem in
// common/src/app/common/schema/messages.cljc:
//   ::sm/text     -> field-missing / field-not-all-whitespace / field-{min,max}-length
//   ::sm/email    -> invalid-email (the schema overrides error/fn)
//   ::sm/password -> password-too-short
//   [:and :boolean [:= true]] -> invalid-data

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { tr } from "@/lib/i18n";

export type FieldType =
  | "text"
  | "email"
  | "password"
  | "checkbox"
  | "select"
  | "radio"
  | "textarea";

export interface FieldSpec {
  type: FieldType;
  // malli {:optional true}: an empty value means "absent" and is dropped from
  // the submitted data instead of being reported as missing.
  optional?: boolean;
  min?: number;
  max?: number;
  // checkbox only: the [:and :boolean [:= true]] shape used by the terms box.
  mustBeTrue?: boolean;
  // select/radio only: the [::sm/one-of #{...}] membership check.
  oneOf?: readonly string[];
}

export type FieldSpecs = Record<string, FieldSpec>;
export type FormValues = Record<string, string | boolean>;
export type CleanData = Record<string, string | boolean>;

// Port of email-re in common/src/app/common/schema.cljc.
const emailRe =
  /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,63}$/;

export const passwordMinLength = 8;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function validateNonEmpty(spec: FieldSpec, raw: string): string | null {
  switch (spec.type) {
    case "email":
      if (!emailRe.test(raw)) return tr("errors.invalid-email");
      break;
    case "password":
      if (raw.length < passwordMinLength) return tr("errors.password-too-short");
      break;
    default:
      break;
  }
  if (spec.max !== undefined && raw.length > spec.max) return tr("errors.field-max-length", spec.max);
  if (spec.min !== undefined && raw.length < spec.min) return tr("errors.field-min-length", spec.min);
  return null;
}

export function validateField(spec: FieldSpec, value: unknown): string | null {
  if (spec.type === "checkbox") {
    if (spec.mustBeTrue && value !== true) return tr("errors.invalid-data");
    return null;
  }
  const raw = asString(value);
  const textLike =
    spec.type === "text" ||
    spec.type === "textarea" ||
    spec.type === "select" ||
    spec.type === "radio";
  if (raw.length === 0) {
    if (spec.optional) return null;
    return textLike ? tr("errors.field-missing") : validateNonEmpty(spec, raw);
  }
  if (spec.oneOf !== undefined && !spec.oneOf.includes(raw)) {
    return tr("errors.invalid-data");
  }
  if ((spec.type === "text" || spec.type === "textarea") && raw.trim().length === 0) {
    return spec.optional ? null : tr("errors.field-not-all-whitespace");
  }
  return validateNonEmpty(spec, raw);
}

// Form-level constraints: the [:fn {:error/fn ... :error/field ...}] shapes,
// e.g. the password confirmation check in app.main.ui.auth.recovery.
export interface FormValidator {
  field: string;
  message: string;
  check: (values: FormValues) => boolean;
}

export function validateAll(
  specs: FieldSpecs,
  values: FormValues,
  validators: FormValidator[] = [],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const name of Object.keys(specs)) {
    const message = validateField(specs[name], values[name]);
    if (message !== null) errors[name] = message;
  }
  for (const validator of validators) {
    if (errors[validator.field] !== undefined) continue;
    if (!validator.check(values)) errors[validator.field] = validator.message;
  }
  return errors;
}

// sm/decode with the json transformer leaves strings untouched; the shell only
// has to drop absent optional values and normalize checkboxes to booleans.
export function cleanValues(specs: FieldSpecs, values: FormValues): CleanData {
  const data: CleanData = {};
  for (const name of Object.keys(specs)) {
    const spec = specs[name];
    if (spec.type === "checkbox") {
      data[name] = values[name] === true;
      continue;
    }
    // A select or radio group always carries a definite choice, and "" can be a
    // real option (the "Auto (browser)" locale), so it is kept, not dropped.
    if (spec.type === "select" || spec.type === "radio") {
      data[name] = asString(values[name]);
      continue;
    }
    const raw = asString(values[name]);
    if (raw.length === 0) {
      if (!spec.optional) data[name] = raw;
      continue;
    }
    data[name] = raw;
  }
  return data;
}

export interface FormState {
  values: FormValues;
  // Schema errors merged with server-side errors (form :extra-errors).
  errors: Record<string, string>;
  touched: Record<string, boolean>;
  valid: boolean;
  submitted: boolean;
  setSubmitted: (value: boolean) => void;
  setValue: (name: string, value: string | boolean) => void;
  touch: (name: string) => void;
  touchAll: () => void;
  setFieldError: (name: string, message: string | null) => void;
  clearFieldErrors: () => void;
  cleanData: CleanData;
  reset: () => void;
}

export interface UseFormOptions {
  specs: FieldSpecs;
  initial?: FormValues;
  validators?: FormValidator[];
}

export function useForm({ specs, initial, validators = [] }: UseFormOptions): FormState {
  const initialValues = useMemo<FormValues>(() => {
    const values: FormValues = {};
    for (const name of Object.keys(specs)) {
      values[name] = specs[name].type === "checkbox" ? false : "";
    }
    return { ...values, ...(initial ?? {}) };
    // The CLJS forms capture the initial data once (mf/use-memo on params), so
    // the shell does the same: a later query-string change remounts the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [values, setValues] = useState<FormValues>(initialValues);
  const [extraErrors, setExtraErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);

  const schemaErrors = useMemo(
    () => validateAll(specs, values, validators),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [values, validators],
  );
  const errors = useMemo(() => ({ ...schemaErrors, ...extraErrors }), [schemaErrors, extraErrors]);
  const valid = Object.keys(errors).length === 0;
  const cleanData = useMemo(
    () => (valid ? cleanValues(specs, values) : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [valid, values],
  );

  const setValue = useCallback((name: string, value: string | boolean) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setTouched((prev) => (prev[name] ? prev : { ...prev, [name]: true }));
    setExtraErrors((prev) => {
      if (prev[name] === undefined) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }, []);

  const touch = useCallback((name: string) => {
    setTouched((prev) => (prev[name] ? prev : { ...prev, [name]: true }));
  }, []);

  const touchAll = useCallback(() => {
    setTouched(() => {
      const next: Record<string, boolean> = {};
      for (const name of Object.keys(specs)) next[name] = true;
      return next;
    });
  }, [specs]);

  const setFieldError = useCallback((name: string, message: string | null) => {
    setExtraErrors((prev) => {
      const next = { ...prev };
      if (message === null) delete next[name];
      else next[name] = message;
      return next;
    });
    if (message !== null) setTouched((prev) => ({ ...prev, [name]: true }));
  }, []);

  const clearFieldErrors = useCallback(() => setExtraErrors({}), []);

  const reset = useCallback(() => {
    setValues(initialValues);
    setExtraErrors({});
    setTouched({});
    setSubmitted(false);
  }, [initialValues]);

  return {
    values,
    errors,
    touched,
    valid,
    submitted,
    setSubmitted,
    setValue,
    touch,
    touchAll,
    setFieldError,
    clearFieldErrors,
    cleanData,
    reset,
  };
}

// Shared by components/form.tsx; declared here so the hook and the fields can
// live on either side of the headless/view split.
export const FormContext = createContext<FormState | null>(null);

export function useFormContext(): FormState {
  const form = useContext(FormContext);
  if (form === null) throw new Error("form field used outside <Form>");
  return form;
}
