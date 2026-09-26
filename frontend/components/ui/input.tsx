"use client";

import type { InputHTMLAttributes, ReactNode } from "react";
import { FieldShell, controlStyles, useFieldControl } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  leadingIcon?: ReactNode;
  containerClassName?: string;
}

export function Input({
  label,
  hint,
  error,
  leadingIcon,
  className,
  containerClassName,
  id,
  type = "text",
  ...props
}: InputProps) {
  const { fieldId, describedBy, invalid } = useFieldControl({ id, hint, error });

  const control = (
    <input
      id={fieldId}
      type={type}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className={cn(
        controlStyles({ invalid }),
        "h-12",
        leadingIcon ? "pl-11" : undefined,
        className,
      )}
      {...props}
    />
  );

  return (
    <FieldShell
      id={fieldId}
      label={label}
      hint={hint}
      error={error}
      required={props.required}
      className={containerClassName}
    >
      {leadingIcon ? (
        <div className="relative">
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-ink-subtle"
          >
            {leadingIcon}
          </span>
          {control}
        </div>
      ) : (
        control
      )}
    </FieldShell>
  );
}
