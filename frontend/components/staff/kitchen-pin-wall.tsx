"use client";

import { Delete, KeyRound, LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { FieldShell, controlStyles, useFieldControl } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { checkKdsLogin } from "@/lib/api";
import { cn } from "@/lib/utils";

const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

export interface KitchenPinWallProps {
  onSuccess: () => void;
}

export function KitchenPinWall({ onSuccess }: KitchenPinWallProps) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { fieldId, describedBy, invalid } = useFieldControl({ error: error ?? undefined });

  async function submit(value: string) {
    if (busy) return;

    if (!value) {
      setError("Enter the kitchen PIN.");
      return;
    }

    setBusy(true);
    setError(null);

    const result = await checkKdsLogin(value);

    if (!result.ok) {
      setBusy(false);
      setError(result.message ?? "That PIN does not match.");
      setPin("");
      return;
    }

    onSuccess();
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(pin);
  }

  function append(key: string) {
    if (busy) return;
    setError(null);
    setPin((current) => (current.length >= 8 ? current : current + key));
  }

  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-8 px-5 py-14">
      <Container size="narrow" className="flex flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo />
          <p className="text-sm text-ink-muted">Staff-only screens for the kitchen line.</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex w-full max-w-sm flex-col gap-5 rounded-xl border border-line bg-surface p-6 shadow-md sm:p-8"
          noValidate
        >
          <div className="flex flex-col items-center gap-2 text-center">
            <span className="flex size-11 items-center justify-center rounded-pill bg-dark-brown text-cream">
              <KeyRound className="size-5" aria-hidden />
            </span>
            <h1 className="font-display text-subheading text-ink">Enter kitchen staff PIN</h1>
            <p className="text-sm text-ink-muted">The board stays hidden until the PIN matches.</p>
          </div>

          <FieldShell id={fieldId} error={error ?? undefined}>
            <input
              id={fieldId}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              aria-describedby={describedBy}
              aria-label="Kitchen staff PIN"
              aria-invalid={invalid || undefined}
              value={pin}
              maxLength={8}
              onChange={(event) => {
                setError(null);
                setPin(event.target.value.replace(/\D/g, "").slice(0, 8));
              }}
              placeholder="••••"
              className={cn(
                controlStyles({ invalid }),
                "h-14 text-center font-display text-2xl tracking-[0.4em]",
              )}
            />
          </FieldShell>

          <div className="grid grid-cols-3 gap-2.5" role="group" aria-label="PIN keypad">
            {keys.map((key) => (
              <button
                key={key}
                type="button"
                disabled={busy}
                onClick={() => append(key)}
                className="flex h-14 cursor-pointer items-center justify-center rounded-md border border-line bg-paper font-display text-xl text-ink transition-colors duration-[var(--duration-fast)] hover:border-line-strong hover:bg-beige/60 active:bg-beige disabled:pointer-events-none disabled:opacity-45"
              >
                {key}
              </button>
            ))}

            <button
              type="button"
              disabled={busy}
              aria-label="Delete last digit"
              onClick={() => setPin((current) => current.slice(0, -1))}
              className="flex h-14 cursor-pointer items-center justify-center rounded-md border border-line bg-paper text-ink-muted transition-colors duration-[var(--duration-fast)] hover:bg-beige/60 disabled:pointer-events-none disabled:opacity-45"
            >
              <Delete className="size-5" aria-hidden />
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={() => append("0")}
              className="flex h-14 cursor-pointer items-center justify-center rounded-md border border-line bg-paper font-display text-xl text-ink transition-colors duration-[var(--duration-fast)] hover:border-line-strong hover:bg-beige/60 active:bg-beige disabled:pointer-events-none disabled:opacity-45"
            >
              0
            </button>

            <button
              type="submit"
              disabled={busy}
              aria-label="Unlock board"
              className="flex h-14 cursor-pointer items-center justify-center rounded-md bg-dark-brown text-cream transition-colors duration-[var(--duration-fast)] hover:bg-clay disabled:pointer-events-none disabled:opacity-45"
            >
              {busy ? <Spinner size="sm" label="Checking PIN" /> : <LogIn className="size-5" aria-hidden />}
            </button>
          </div>

          <Button type="submit" size="lg" fullWidth loading={busy}>
            Unlock board
          </Button>

          <p className="text-center text-xs leading-relaxed text-ink-subtle">
            Set <span className="font-medium text-ink-muted">STAFF_PIN</span> in the environment to
            change it — the fallback for a fresh clone is 1234.
          </p>
        </form>
      </Container>
    </main>
  );
}
