"use client";

import type { TextareaHTMLAttributes } from "react";
import { FieldShell, controlStyles, useFieldControl } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
  containerClassName?: string;
}

export function Textarea({
  label,
  hint,
  error,
  className,
  containerClassName,
  id,
  rows = 3,
  ...props
}: TextareaProps) {
  const { fieldId, describedBy, invalid } = useFieldControl({ id, hint, error });

  return (
    <FieldShell
      id={fieldId}
      label={label}
      hint={hint}
      error={error}
      required={props.required}
      className={containerClassName}
    >
      <textarea
        id={fieldId}
        rows={rows}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn(controlStyles({ invalid }), "resize-y py-3 leading-relaxed", className)}
        {...props}
      />
    </FieldShell>
  );
}
