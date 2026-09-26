"use client";

import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface FieldControlOptions {
  id?: string;
  hint?: string;
  error?: string;
}

export function useFieldControl({ id, hint, error }: FieldControlOptions) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const describedBy =
    [error ? `${fieldId}-error` : null, hint ? `${fieldId}-hint` : null]
      .filter(Boolean)
      .join(" ") || undefined;

  return { fieldId, describedBy, invalid: Boolean(error) };
}

export function controlStyles({ invalid = false }: { invalid?: boolean } = {}) {
  return cn(
    "w-full rounded-md border bg-paper px-4 text-base text-ink transition-[border-color,box-shadow] duration-[var(--duration-fast)] ease-gentle",
    "placeholder:text-ink-subtle/85 focus:outline-none focus:ring-4 disabled:cursor-not-allowed disabled:opacity-60",
    invalid
      ? "border-alert focus:border-alert focus:ring-alert/20"
      : "border-line focus:border-brown focus:ring-beige/55",
  );
}

export interface FieldShellProps {
  id: string;
  label?: ReactNode;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

export function FieldShell({
  id,
  label,
  hint,
  error,
  required,
  className,
  children,
}: FieldShellProps) {
  return (
    <div className={cn("flex w-full flex-col gap-2", className)}>
      {label ? (
        <label htmlFor={id} className="text-label text-ink-muted uppercase">
          {label}
          {required ? (
            <span aria-hidden className="ml-1 text-alert">
              *
            </span>
          ) : null}
        </label>
      ) : null}

      {children}

      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
