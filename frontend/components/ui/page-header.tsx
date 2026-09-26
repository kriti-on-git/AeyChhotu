import type { ReactNode } from "react";
import { SectionHeader } from "@/components/ui/section-header";

export interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ eyebrow, title, description, actions, className }: PageHeaderProps) {
  return (
    <SectionHeader
      as="header"
      size="page"
      eyebrow={eyebrow}
      title={title}
      description={description}
      actions={actions}
      className={className}
    />
  );
}
