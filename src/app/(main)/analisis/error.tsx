"use client";

import { Button } from "@/components/ui/button";

// Nunca mostrar error.message: puede traer detalle técnico.
// Next 16.3+: el prop estable es `retry` (ver node_modules/next/dist/docs/
// 01-app/03-api-reference/03-file-conventions/error.md), no `reset`.
export default function AnalisisError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <h1 className="font-display text-2xl font-semibold">Análisis</h1>
      <p role="alert" className="text-sm">
        No se pudo cargar el análisis, intenta de nuevo en unos minutos.
      </p>
      <Button onClick={() => retry()} variant="outline" size="sm">
        Reintentar
      </Button>
    </main>
  );
}
