// Visual form fields for the shell: the subset of app.main.ui.components.forms
// the migrated pages need. State and validation live in lib/forms.ts.
//
// The CLJS forms render the ds input and button components from @penpot/ui
// (React + react-aria-components + SCSS modules, exports pointing at an unbuilt
// dist). Wiring that package is tracked with F4/F5; until then styles/forms.css
// gives the fields the same visual contract from the design tokens.
//
// Like fm/submit-button*, the submit button is disabled while the form is
// invalid, so onSubmit only ever receives clean data.

import type { FormEvent, ReactNode } from "react";
import { FormContext, useFormContext, type CleanData, type FormState } from "@/lib/forms";

export interface FormProps {
  form: FormState;
  onSubmit: (data: CleanData) => void;
  className?: string;
  children: ReactNode;
}

export function Form({ form, onSubmit, className, children }: FormProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    form.touchAll();
    if (!form.valid) return;
    onSubmit(form.cleanData);
  };
  return (
    <FormContext.Provider value={form}>
      <form className={className} onSubmit={handleSubmit} noValidate>
        {children}
      </form>
    </FormContext.Provider>
  );
}

function fieldError(form: FormState, name: string): string | null {
  return form.touched[name] === true ? (form.errors[name] ?? null) : null;
}

export interface FieldProps {
  name: string;
  label: string;
  hint?: string;
  type?: "text" | "email" | "password";
  placeholder?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  testId?: string;
}

export function Field({
  name,
  label,
  hint,
  type = "text",
  placeholder,
  autoComplete,
  autoFocus,
  disabled,
  testId,
}: FieldProps) {
  const form = useFormContext();
  const value = typeof form.values[name] === "string" ? (form.values[name] as string) : "";
  const error = fieldError(form, name);
  const valid = form.touched[name] === true && error === null;
  const id = "pp-field-" + name;
  return (
    <div className="pp-field">
      <label className="pp-field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="pp-field-input"
        type={type}
        name={name}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-invalid={error !== null ? true : undefined}
        aria-describedby={error !== null ? id + "-error" : undefined}
        data-testid={testId}
        data-valid={valid ? "true" : undefined}
        onChange={(event) => form.setValue(name, event.target.value)}
        onBlur={() => form.touch(name)}
      />
      {hint !== undefined && error === null ? <div className="pp-field-hint">{hint}</div> : null}
      {error !== null ? (
        <div className="pp-field-error" id={id + "-error"} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export interface CheckboxProps {
  name: string;
  label: ReactNode;
  testId?: string;
  className?: string;
}

export function Checkbox({ name, label, testId, className }: CheckboxProps) {
  const form = useFormContext();
  const checked = form.values[name] === true;
  const error = fieldError(form, name);
  const id = "pp-field-" + name;
  return (
    <div className={"pp-checkbox" + (className !== undefined ? " " + className : "")}>
      <label className="pp-checkbox-label" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          name={name}
          checked={checked}
          data-testid={testId}
          aria-invalid={error !== null ? true : undefined}
          onChange={(event) => form.setValue(name, event.target.checked)}
          onBlur={() => form.touch(name)}
        />
        <span className="pp-checkbox-text">{label}</span>
      </label>
      {error !== null ? (
        <div className="pp-field-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export interface SubmitButtonProps {
  label: string;
  disabled?: boolean;
  testId?: string;
  className?: string;
}

export function SubmitButton({ label, disabled, testId, className }: SubmitButtonProps) {
  const form = useFormContext();
  const isDisabled = !form.valid || disabled === true || form.submitted;
  return (
    <button
      type="submit"
      className={"pp-submit" + (className !== undefined ? " " + className : "")}
      disabled={isDisabled}
      data-testid={testId}
    >
      {label}
    </button>
  );
}

export interface SelectOption {
  label: string;
  value: string;
}

export interface SelectProps {
  name: string;
  // fm/select renders without a label in several forms (the change-owner and
  // webhook selects); the label element only appears when one is given.
  label?: string;
  options: readonly SelectOption[];
  testId?: string;
  className?: string;
}

// fm/select equivalent. The CLJS ds select is a listbox popover; a native
// select keeps the same value contract and stays keyboard/AT accessible until
// @penpot/ui is wired.
export function Select({ name, label, options, testId, className }: SelectProps) {
  const form = useFormContext();
  const value = typeof form.values[name] === "string" ? (form.values[name] as string) : "";
  const error = fieldError(form, name);
  const id = "pp-field-" + name;
  return (
    <div className={"pp-field" + (className !== undefined ? " " + className : "")}>
      {label !== undefined ? (
        <label className="pp-field-label" htmlFor={id}>
          {label}
        </label>
      ) : null}
      <select
        id={id}
        className="pp-field-input"
        name={name}
        value={value}
        data-testid={testId}
        aria-invalid={error !== null ? true : undefined}
        aria-describedby={error !== null ? id + "-error" : undefined}
        onChange={(event) => form.setValue(name, event.target.value)}
        onBlur={() => form.touch(name)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error !== null ? (
        <div className="pp-field-error" id={id + "-error"} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export interface RadioGroupProps {
  name: string;
  legend?: string;
  options: readonly SelectOption[];
  testId?: string;
  className?: string;
}

// fm/radio-buttons equivalent.
export function RadioGroup({ name, legend, options, testId, className }: RadioGroupProps) {
  const form = useFormContext();
  const value = typeof form.values[name] === "string" ? (form.values[name] as string) : "";
  const error = fieldError(form, name);
  return (
    <fieldset
      className={"pp-radio-group" + (className !== undefined ? " " + className : "")}
      aria-invalid={error !== null ? true : undefined}
    >
      {legend !== undefined ? <legend className="pp-field-label">{legend}</legend> : null}
      {options.map((option) => {
        const id = "pp-field-" + name + "-" + option.value;
        return (
          <label key={option.value} className="pp-radio" htmlFor={id}>
            <input
              id={id}
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              data-testid={testId !== undefined ? testId + "-" + option.value : undefined}
              onChange={() => form.setValue(name, option.value)}
            />
            <span className="pp-radio-text">{option.label}</span>
          </label>
        );
      })}
      {error !== null ? (
        <div className="pp-field-error" role="alert">
          {error}
        </div>
      ) : null}
    </fieldset>
  );
}

export interface TextareaProps {
  name: string;
  label: string;
  placeholder?: string;
  rows?: number;
  testId?: string;
  className?: string;
}

// fm/textarea equivalent.
export function Textarea({
  name,
  label,
  placeholder,
  rows = 5,
  testId,
  className,
}: TextareaProps) {
  const form = useFormContext();
  const value = typeof form.values[name] === "string" ? (form.values[name] as string) : "";
  const error = fieldError(form, name);
  const id = "pp-field-" + name;
  return (
    <div className={"pp-field" + (className !== undefined ? " " + className : "")}>
      <label className="pp-field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="pp-field-input pp-field-textarea"
        name={name}
        rows={rows}
        value={value}
        placeholder={placeholder}
        data-testid={testId}
        aria-invalid={error !== null ? true : undefined}
        aria-describedby={error !== null ? id + "-error" : undefined}
        onChange={(event) => form.setValue(name, event.target.value)}
        onBlur={() => form.touch(name)}
      />
      {error !== null ? (
        <div className="pp-field-error" id={id + "-error"} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
