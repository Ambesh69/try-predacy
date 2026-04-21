"use client";

import { useEffect, useState } from "react";
import { clsx } from "clsx";

export type ToastKind = "success" | "error" | "info";

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

let toastCounter = 0;
const listeners = new Set<(toast: ToastMessage) => void>();

export function pushToast(kind: ToastKind, title: string, description?: string) {
  const toast: ToastMessage = { id: ++toastCounter, kind, title, description };
  listeners.forEach((fn) => fn(toast));
}

export function ToastHost() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    const handler = (toast: ToastMessage) => {
      setToasts((prev) => [...prev, toast]);
      // Auto-dismiss after 5s
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id));
      }, 5000);
    };
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[10000] flex flex-col gap-2 max-w-sm pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={clsx(
            "pointer-events-auto p-3 border bg-bg/95 backdrop-blur-md animate-slide-up shadow-[0_8px_24px_rgba(0,0,0,0.4)]",
            toast.kind === "success" && "border-accent/40",
            toast.kind === "error" && "border-danger/40",
            toast.kind === "info" && "border-blue/40",
          )}
        >
          <div className="flex items-start gap-2">
            {toast.kind === "success" && (
              <svg className="w-4 h-4 text-accent flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
            {toast.kind === "error" && (
              <svg className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
            {toast.kind === "info" && (
              <svg className="w-4 h-4 text-blue flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            <div className="flex-1 min-w-0">
              <p className={clsx("text-[11px] font-bold tracking-widest uppercase",
                toast.kind === "success" && "text-accent",
                toast.kind === "error" && "text-danger",
                toast.kind === "info" && "text-blue",
              )}>{toast.title}</p>
              {toast.description && (
                <p className="text-[10px] text-muted mt-0.5">{toast.description}</p>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
