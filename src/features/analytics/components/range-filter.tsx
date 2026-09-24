"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { InsightsRange, RangePreset } from "../lib/schemas";

const PRESETS: RangePreset[] = ["7", "30", "90"];

export function buildAnalisisHref(next: { preset?: RangePreset; from?: string; to?: string; tags: string[] }) {
  const q = new URLSearchParams();
  if (next.preset) q.set("range", next.preset);
  if (next.from && next.to) {
    q.set("from", next.from);
    q.set("to", next.to);
  }
  // Un parámetro repetido por etiqueta. `tags.join(",")` rompería las
  // etiquetas que contienen comas ("precio, alto" → dos columnas inexistentes,
  // porcentajes mal y el tope de 5 disparándose de mentira), y las etiquetas
  // de contacto sí admiten comas.
  for (const tag of next.tags) q.append("tags", tag);
  const s = q.toString();
  return s ? `/analisis?${s}` : "/analisis";
}

export function RangeFilter({ range }: { range: InsightsRange }) {
  const router = useRouter();

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        router.push(
          buildAnalisisHref({ from: String(f.get("from")), to: String(f.get("to")), tags: range.tags }),
        );
      }}
    >
      <div className="flex gap-1" role="group" aria-label="Período">
        {PRESETS.map((p) => (
          <Button
            key={p}
            type="button"
            size="sm"
            variant={range.preset === p ? "default" : "outline"}
            aria-pressed={range.preset === p}
            onClick={() => router.push(buildAnalisisHref({ preset: p, tags: range.tags }))}
          >
            {p} días
          </Button>
        ))}
      </div>
      <div className="grid gap-1">
        <Label htmlFor="analisis-from">Desde</Label>
        {/* El análisis llega hasta ayer; la UI no ofrece días posteriores. */}
        <Input id="analisis-from" name="from" type="date" defaultValue={range.fromDate} max={range.toDate} required />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="analisis-to">Hasta</Label>
        <Input id="analisis-to" name="to" type="date" defaultValue={range.toDate} max={range.toDate} required />
      </div>
      <Button type="submit" size="sm" variant="secondary">
        Aplicar
      </Button>
    </form>
  );
}
