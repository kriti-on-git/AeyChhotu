import { QrCode } from "lucide-react";
import Link from "next/link";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { EmptyState } from "@/components/ui/empty-state";
import { demoTableToken } from "@/lib/site";

export function InactiveTableState() {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-5 py-20">
      <Container size="narrow" className="flex flex-col items-center gap-6 text-center">
        <EmptyState
          tone="alert"
          icon={QrCode}
          titleAs="h1"
          title="This table link is not active"
          description="The QR code may have been replaced or the table closed. Ask a host for the current code, or try the demo table."
          className="w-full"
        />
        <div className="flex flex-wrap justify-center gap-3">
          <Link href={`/table/${demoTableToken}`} className={buttonStyles({ size: "md" })}>
            Open demo table {demoTableToken}
          </Link>
          <Link href="/" className={buttonStyles({ variant: "outline", size: "md" })}>
            Back to home
          </Link>
        </div>
      </Container>
    </main>
  );
}
