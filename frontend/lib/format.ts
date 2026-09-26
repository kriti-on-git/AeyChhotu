const currency = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

export function formatPrice(amount: number) {
  return currency.format(amount);
}

/** Compact elapsed label for kitchen ticket timers, e.g. "2m 14s". */
export function formatElapsed(createdAt: string, now: number) {
  const elapsed = Math.max(0, now - new Date(createdAt).getTime());
  const totalSeconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function formatTableLabel(code: string) {
  return `Table ${code}`;
}
