"use client";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { BusinessInfoForm } from "./business-info-form";
import { ToolsCatalog } from "./tools-catalog";
import { IntegrationsTab } from "./integrations-tab";
import { TeamTab } from "./team-tab";
import { TemplatesTab } from "./templates-tab";
import { AutomationsTab } from "./automations-tab";
import { N8nToolsTab } from "./n8n-tools-tab";
import { KbTab } from "./kb-tab";
import { AgentsTab } from "@/features/agents/components/agents-tab";
import type { AgentDto } from "@/features/agents/types";

interface ToolItem {
  id: string;
  key: string;
  name: string;
  description: string | null;
  sensitivity: string | null;
  enabled: boolean;
  config: Record<string, unknown> | null;
}

interface Props {
  workspaceId: string;
  role: string;
  initialBusinessInfo: Record<string, unknown> | null;
  initialTools: ToolItem[];
  initialIntegrations: unknown[];
  initialTemplates?: unknown[];
  initialAgents?: AgentDto[];
}

export function SettingsShell({
  workspaceId,
  initialBusinessInfo,
  initialTools,
  initialIntegrations,
  initialTemplates = [],
  initialAgents = [],
}: Props) {
  const biForForm = initialBusinessInfo as {
    structured: Record<string, unknown>;
    free_text: string | null;
  } | null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-xl font-semibold text-foreground mb-6">
        Configuración del Workspace
      </h1>

      <Tabs defaultValue="agentes">
        {/* Scroll the tab strip within its own track instead of letting 11 tabs
            push horizontal overflow onto the whole page. */}
        <div className="mb-6 -mx-1 overflow-x-auto px-1 pb-1">
          <TabsList className="w-max">
            <TabsTrigger value="agentes">Agentes</TabsTrigger>
            <TabsTrigger value="integraciones">Integraciones</TabsTrigger>
            <TabsTrigger value="negocio">Negocio</TabsTrigger>
            <TabsTrigger value="tools">Tools</TabsTrigger>
            <TabsTrigger value="n8n">n8n</TabsTrigger>
            <TabsTrigger value="templates">Templates</TabsTrigger>
            <TabsTrigger value="knowledge-base">Knowledge Base</TabsTrigger>
            <TabsTrigger value="equipo">Equipo</TabsTrigger>
            <TabsTrigger value="automatizaciones">Automatizaciones</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="agentes">
          <div className="p-6 space-y-6 rounded-lg border border-border/60 bg-card">
            <AgentsTab
              workspaceId={workspaceId}
              initialAgents={initialAgents}
            />
          </div>
        </TabsContent>

        <TabsContent value="integraciones">
          <div className="p-6 space-y-6 rounded-lg border border-border/60 bg-card">
            <IntegrationsTab
              workspaceId={workspaceId}
              initialIntegrations={initialIntegrations}
            />
          </div>
        </TabsContent>

        <TabsContent value="negocio">
          <div className="p-6 space-y-6 rounded-lg border border-border/60 bg-card">
            <BusinessInfoForm workspaceId={workspaceId} initial={biForForm} />
          </div>
        </TabsContent>

        <TabsContent value="tools">
          <div className="p-6 space-y-6 rounded-lg border border-border/60 bg-card">
            <ToolsCatalog
              workspaceId={workspaceId}
              initialTools={initialTools}
            />
          </div>
        </TabsContent>

        <TabsContent value="n8n">
          <div className="p-6 space-y-6 rounded-lg border border-border/60 bg-card">
            <N8nToolsTab workspaceId={workspaceId} />
          </div>
        </TabsContent>

        <TabsContent value="templates">
          <div className="p-6 rounded-lg border border-border/60 bg-card">
            <TemplatesTab
              workspaceId={workspaceId}
              initialTemplates={initialTemplates}
            />
          </div>
        </TabsContent>
        <TabsContent value="knowledge-base">
          <div className="p-6 space-y-6 rounded-lg border border-border/60 bg-card">
            <KbTab workspaceId={workspaceId} />
          </div>
        </TabsContent>

        <TabsContent value="equipo">
          <div className="p-6 space-y-6 rounded-lg border border-border/60 bg-card">
            <TeamTab workspaceId={workspaceId} />
          </div>
        </TabsContent>

        <TabsContent value="automatizaciones">
          <div className="p-6 space-y-6 rounded-lg border border-border/60 bg-card">
            <AutomationsTab workspaceId={workspaceId} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
