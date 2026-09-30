/* Cultural formatting engine (integration spec §5):
   - Money renders as "Rs. 120.00" (2 decimals, Indian grouping).
   - Timestamps render in IST (Asia/Kolkata) everywhere. */

const currency = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPrice(amount: number) {
  return `Rs. ${currency.format(amount)}`;
}

const istTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const istDateTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** "7:05 pm IST" — every clock in the product speaks IST. */
export function formatIstTime(value: string | Date) {
  return `${istTime.format(new Date(value))} IST`;
}

/** "27 Sep, 7:05 pm IST" — for absolute fired/served stamps. */
export function formatIstDateTime(value: string | Date) {
  return `${istDateTime.format(new Date(value))} IST`;
}

/** Compact elapsed label for kitchen ticket timers, e.g. "2m 14s". */
export function formatElapsed(createdAt: string, now: number) {
  const elapsed = Math.max(0, now - new Date(createdAt).getTime());
  const totalSeconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}


