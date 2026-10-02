"use client";

// Modal host (F4). The CLJS app keeps a single modal slot in the store
// (app.main.data.modal) and renders it from modal-container*, so any component
// can open a dialog without prop drilling. This is the same shape on a context.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface ModalApi {
  element: ReactNode | null;
  open: (element: ReactNode) => void;
  close: () => void;
}

const ModalContext = createContext<ModalApi | null>(null);

export function ModalProvider({ children }: { children: ReactNode }) {
  const [element, setElement] = useState<ReactNode | null>(null);
  const open = useCallback((next: ReactNode) => setElement(next), []);
  const close = useCallback(() => setElement(null), []);
  const value = useMemo<ModalApi>(() => ({ element, open, close }), [element, open, close]);

  useEffect(() => {
    if (element === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [element, close]);

  return (
    <ModalContext.Provider value={value}>
      {children}
      {element !== null ? (
        <div className="pp-modal-backdrop" onClick={close}>
          <div
            className="pp-modal"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            {element}
          </div>
        </div>
      ) : null}
    </ModalContext.Provider>
  );
}

export function useModal(): ModalApi {
  const api = useContext(ModalContext);
  if (api === null) throw new Error("useModal used outside <ModalProvider>");
  return api;
}

export interface ModalShellProps {
  title: string;
  titleTestId?: string;
  closeLabel: string;
  children: ReactNode;
  footer?: ReactNode;
}

// The shared header/content/footer frame the CLJS modals repeat
// (modal-header + modal-title + modal-close-btn + modal-content + modal-footer).
export function ModalShell({ title, titleTestId, closeLabel, children, footer }: ModalShellProps) {
  const { close } = useModal();
  return (
    <div className="pp-modal-container">
      <div className="pp-modal-header">
        <h2 className="pp-modal-title" data-testid={titleTestId}>
          {title}
        </h2>
        <button type="button" className="pp-modal-close" aria-label={closeLabel} onClick={close}>
          ×
        </button>
      </div>
      <div className="pp-modal-content">{children}</div>
      {footer !== undefined ? <div className="pp-modal-footer">{footer}</div> : null}
    </div>
  );
}

export interface ConfirmDialogProps {
  title: string;
  message: string;
  acceptLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  acceptTestId?: string;
  onAccept: () => void;
}

// The {:type :confirm} branch of app.main.data.modal.
export function ConfirmDialog({
  title,
  message,
  acceptLabel,
  cancelLabel,
  destructive,
  acceptTestId,
  onAccept,
}: ConfirmDialogProps) {
  const { close } = useModal();
  return (
    <ModalShell
      title={title}
      closeLabel={cancelLabel}
      footer={
        <div className="pp-modal-actions">
          <button type="button" className="pp-btn-secondary" onClick={close}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={destructive === true ? "pp-btn-danger" : "pp-btn-primary"}
            data-testid={acceptTestId}
            onClick={() => {
              close();
              onAccept();
            }}
          >
            {acceptLabel}
          </button>
        </div>
      }
    >
      <p className="pp-modal-message">{message}</p>
    </ModalShell>
  );
}
