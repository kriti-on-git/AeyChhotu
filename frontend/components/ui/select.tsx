"use client";

import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";
import { FieldShell, controlStyles, useFieldControl } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
  options: SelectOption[];
  placeholder?: string;
  containerClassName?: string;
}

export function Select({
  label,
  hint,
  error,
  options,
  placeholder,
  className,
  containerClassName,
  id,
  ...props
}: SelectProps) {
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
      <div className="relative">
        <select
          id={fieldId}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={cn(
            controlStyles({ invalid }),
            "h-12 cursor-pointer appearance-none pr-11",
            className,
          )}
          {...props}
        >
          {placeholder ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2 text-ink-subtle"
        />
      </div>
    </FieldShell>
  );
}
