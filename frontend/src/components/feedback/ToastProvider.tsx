import { CheckCircle2, CircleAlert } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

type ToastTone = 'success' | 'error';
type ToastItem = { id: number; message: string; tone: ToastTone };
type ToastApi = { success: (message: string) => void; error: (message: string) => void };

const ToastContext = createContext<ToastApi | null>(null);
const TOAST_VISIBLE_MS = 3500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const nextId = useRef(0);
  const timers = useRef(new Map<number, number>());
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => () => {
    timers.current.forEach((timerId) => window.clearTimeout(timerId));
    timers.current.clear();
  }, []);

  const push = useCallback((message: string, tone: ToastTone) => {
    const id = ++nextId.current;
    setItems((current) => [...current, { id, message, tone }]);

    const timerId = window.setTimeout(() => {
      timers.current.delete(id);
      setItems((current) => current.filter((item) => item.id !== id));
    }, TOAST_VISIBLE_MS);
    timers.current.set(id, timerId);
  }, []);

  const value = useMemo<ToastApi>(() => ({
    success: (message) => push(message, 'success'),
    error: (message) => push(message, 'error'),
  }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div aria-label="通知" className="ui-toast-region" data-modal-live-region="true" role="region">
          {items.map((item) => (
            <div
              aria-atomic="true"
              className={'ui-toast ui-toast--' + item.tone}
              key={item.id}
              role={item.tone === 'error' ? 'alert' : 'status'}
            >
              <span aria-hidden="true" className="ui-toast__icon">
                {item.tone === 'error' ? <CircleAlert aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
              </span>
              <span>{item.message}</span>
            </div>
          ))}
        </div>,
        window.document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error('useToast must be used inside ToastProvider');
  }
  return value;
}
