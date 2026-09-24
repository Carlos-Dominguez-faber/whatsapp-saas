"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { evidenceCellLabel, formatPct, type InsightsView } from "../lib/insights-view";
import { MAX_TAG_COLUMNS, type InsightsRange } from "../lib/schemas";
import { EvidenceDialog, type EvidenceTarget } from "./evidence-dialog";
import { buildAnalisisHref } from "./range-filter";

export function CrossTable({
  workspaceId,
  view,
  range,
  availableTags,
}: {
  workspaceId: string;
  view: InsightsView;
  range: InsightsRange;
  availableTags: string[];
}) {
  const router = useRouter();
  const [target, setTarget] = useState<EvidenceTarget | null>(null);

  function toggleTag(tag: string, checked: boolean) {
    const tags = checked ? [...range.tags, tag] : range.tags.filter((t) => t !== tag);
    router.push(
      buildAnalisisHref({
        preset: range.preset ?? undefined,
        from: range.preset ? undefined : range.fromDate,
        to: range.preset ? undefined : range.toDate,
        tags,
      }),
    );
  }

  const cell = (
    topicId: string,
    topicName: string,
    outcome: EvidenceTarget["outcome"],
    columnLabel: string,
    label: string,
    tag?: string,
  ) => (
    <button
      type="button"
      className="tabular-nums underline-offset-2 hover:underline"
      aria-label={evidenceCellLabel(topicName, columnLabel)}
      onClick={() => setTarget({ topicId, topicName, outcome, tag })}
    >
      {label}
    </button>
  );

  return (
    <section aria-labelledby="cross-title" className="space-y-3">
      <h2 id="cross-title" className="text-lg font-semibold">
        Qué pasa con cada tema
      </h2>

      {availableTags.length > 0 && (
        <fieldset className="flex flex-wrap gap-3 text-sm">
          <legend className="mb-1 w-full text-muted-foreground">
            Comparar etiquetas (hasta {MAX_TAG_COLUMNS})
          </legend>
          {availableTags.map((tag) => {
            const checked = range.tags.includes(tag);
            const disabled = !checked && range.tags.length >= MAX_TAG_COLUMNS;
            return (
              <div key={tag} className="flex items-center gap-1.5">
                <Checkbox
                  id={`tag-${tag}`}
                  checked={checked}
                  disabled={disabled}
                  onCheckedChange={(v) => toggleTag(tag, v === true)}
                />
                <Label htmlFor={`tag-${tag}`}>{tag}</Label>
              </div>
            );
          })}
        </fieldset>
      )}

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className="p-3">Tema</th>
              <th scope="col" className="p-3">Conversaciones</th>
              <th scope="col" className="p-3">Agendaron</th>
              <th scope="col" className="p-3">Derivadas</th>
              {range.tags.map((tag) => (
                <th key={tag} scope="col" className="p-3">
                  {tag}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.topics.map((t) => (
              <tr key={t.id} className="border-t">
                <th scope="row" className="p-3 text-left font-medium">
                  {t.name}
                </th>
                <td className="p-3">{cell(t.id, t.name, "all", "Conversaciones", t.conversations.toLocaleString("es-CL"))}</td>
                <td className="p-3">{cell(t.id, t.name, "booked", "Agendaron", formatPct(t.bookedPct))}</td>
                <td className="p-3">{cell(t.id, t.name, "handed_off", "Derivadas", formatPct(t.handedOffPct))}</td>
                {range.tags.map((tag) => (
                  <td key={tag} className="p-3">
                    {cell(t.id, t.name, "tag", tag, formatPct(t.tagPcts[tag] ?? null), tag)}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-t bg-muted/30">
              <th scope="row" className="p-3 text-left font-medium">
                Todas las conversaciones
              </th>
              <td className="p-3 tabular-nums">{view.universe.toLocaleString("es-CL")}</td>
              <td className="p-3 tabular-nums">{formatPct(view.bookedPct)}</td>
              <td className="p-3 tabular-nums">{formatPct(view.handedOffPct)}</td>
              {range.tags.map((tag) => (
                <td key={tag} className="p-3 tabular-nums">
                  {formatPct(view.tagPcts[tag] ?? null)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <EvidenceDialog workspaceId={workspaceId} range={range} target={target} onClose={() => setTarget(null)} />
    </section>
  );
}
