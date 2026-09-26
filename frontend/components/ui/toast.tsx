"use client";

import { AnimatePresence, motion } from "motion/react";
import { CircleAlert, CircleCheck, Info, X, type LucideIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { IconButton } from "@/components/ui/icon-button";
import { easeGentle, transitionBase } from "@/lib/motion";
import { cn } from "@/lib/utils";

export type ToastTone = "info" | "success" | "error";

const defaultDuration = 5000;

const tones: Record<ToastTone, { classes: string; icon: LucideIcon }> = {
  info: { classes: "border-line bg-surface text-ink", icon: Info },
  success: { classes: "border-ready/30 bg-ready-surface text-ink", icon: CircleCheck },
  error: { classes: "border-alert/30 bg-alert-surface text-ink", icon: CircleAlert },
};

export interface Toast {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
  duration: number;
}

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  duration?: number;
}

interface ToastContextValue {
  toast: (input: ToastInput) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = useContext(ToastContext);

  if (!context) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }

  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((input: ToastInput) => {
    counter.current += 1;
    const id = `toast-${counter.current}`;

    setToasts((current) => [
      ...current,
      {
        id,
        title: input.title,
        description: input.description,
        tone: input.tone ?? "info",
        duration: input.duration ?? defaultDuration,
      },
    ]);

    return id;
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-70 flex flex-col items-center gap-3 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:items-end"
      >
        <AnimatePresence initial={false}>
          {toasts.map((item) => (
            <ToastCard key={item.id} toast={item} onDismiss={dismiss} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const { id, title, description, tone, duration } = toast;
  const { classes, icon: Icon } = tones[tone];

  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(id), duration);
    return () => window.clearTimeout(timer);
  }, [id, duration, onDismiss]);

  return (
    <motion.div
      layout
      role="status"
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.16, ease: easeGentle } }}
      transition={transitionBase}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-3 rounded-md border px-4 py-3.5 shadow-md sm:max-w-sm",
        classes,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
        ) : null}
      </div>
      <IconButton label="Dismiss" size="sm" tone="ghost" onClick={() => onDismiss(id)}>
        <X className="size-3.5" aria-hidden />
      </IconButton>
    </motion.div>
  );
}
