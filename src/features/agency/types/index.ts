export interface WorkspaceWithStats {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  member_count: number;
  conversation_count: number;
  kapso_connected: boolean;
}

export type UseCase = "setter" | "soporte" | "agendamiento" | "general";

export interface CreateWorkspaceInput {
  name: string;
  useCase: UseCase;
  clientEmail?: string;
  /** Optional password for the client account; auto-generated if omitted. */
  clientPassword?: string;
}

/** Login credentials to hand to the client (agency-managed accounts, no email). */
export interface ClientCredentials {
  email: string;
  password: string;
}

export type CreateWorkspaceResult =
  | {
      workspaceId: string;
      webhookUrl: string;
      clientCredentials?: ClientCredentials | null;
      error?: never;
    }
  | {
      workspaceId?: never;
      webhookUrl?: never;
      clientCredentials?: never;
      error: string;
    };

export type GetWorkspacesResult =
  | { workspaces: WorkspaceWithStats[]; error?: never }
  | { workspaces?: never; error: string };
