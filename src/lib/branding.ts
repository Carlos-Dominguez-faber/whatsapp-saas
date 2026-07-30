// Per-deployment brand accent override.
//
// The design system ("Glass + Electric Lime", see globals.css) is the product
// default. A deployment dedicated to one customer can tint the accent to their
// brand without forking the stylesheet: set the env vars below in that Vercel
// project only. Unset means every deployment keeps the default look.
//
// Values are raw OKLch triplets "L C H" — the same format globals.css uses, so
// Tailwind can still inject alpha via oklch(var(--token) / <alpha-value>).
// Convert a hex with any OKLch picker; keep L high enough that
// --primary-foreground stays readable on top.
//
//   NEXT_PUBLIC_BRAND_PRIMARY            e.g. "0.4519 0.1632 346.31"
//   NEXT_PUBLIC_BRAND_PRIMARY_FOREGROUND e.g. "0.99 0 0"
//   NEXT_PUBLIC_BRAND_ACCENT             e.g. "0.6708 0.1145 194.03"

const TRIPLET = /^-?\d*\.?\d+\s+-?\d*\.?\d+\s+-?\d*\.?\d+$/;

function triplet(value: string | undefined): string | null {
  const v = value?.trim();
  return v && TRIPLET.test(v) ? v : null;
}

/**
 * Returns a `:root` CSS override for the brand tokens, or null when this
 * deployment has no branding configured.
 *
 * Rendered inline in the root layout so the tint is present on first paint —
 * a client-side swap would flash the default accent first.
 */
export function brandStyleOverride(): string | null {
  const primary = triplet(process.env.NEXT_PUBLIC_BRAND_PRIMARY);
  const primaryFg = triplet(process.env.NEXT_PUBLIC_BRAND_PRIMARY_FOREGROUND);
  const accent = triplet(process.env.NEXT_PUBLIC_BRAND_ACCENT);

  if (!primary && !accent) return null;

  const vars: string[] = [];
  if (primary) {
    // --ring follows --primary so focus states stay on-brand.
    vars.push(`--primary:${primary}`, `--ring:${primary}`, `--chart-1:${primary}`);
  }
  if (primaryFg) vars.push(`--primary-foreground:${primaryFg}`);
  if (accent) vars.push(`--chart-2:${accent}`);

  // Applied to both themes: these tokens are identical in :root and .dark.
  return `:root,.dark{${vars.join(";")}}`;
}
