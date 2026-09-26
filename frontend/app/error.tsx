"use client";

import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { Button, buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { ErrorState } from "@/components/ui/empty-state";

export default function ErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-5 py-20">
      <Container size="narrow" className="flex flex-col items-center gap-6 text-center">
        <ErrorState
          titleAs="h1"
          title="This screen hit a snag"
          description="Something went wrong while rendering the live data. Try again — the table session is untouched."
          action={
            <div className="flex flex-wrap justify-center gap-3">
              <Button onClick={reset} leftIcon={<RotateCcw className="size-4" aria-hidden />}>
                Try again
              </Button>
              <Link href="/" className={buttonStyles({ variant: "outline", size: "md" })}>
                Back to home
              </Link>
            </div>
          }
        />
      </Container>
    </main>
  );
}
