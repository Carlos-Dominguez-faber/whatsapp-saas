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
      needsConfirmation: true;
      existingUser: { email: string; fullName: string | null };
      workspaceId?: never;
      webhookUrl?: never;
      clientCredentials?: never;
      error?: never;
    }
  | {
      workspaceId: string;
      webhookUrl: string;
      clientCredentials?: ClientCredentials | null;
      needsConfirmation?: never;
      error?: never;
    }
  | {
      workspaceId?: never;
      webhookUrl?: never;
      clientCredentials?: never;
      needsConfirmation?: never;
      error: string;
    };

export type GetWorkspacesResult =
  | { workspaces: WorkspaceWithStats[]; error?: never }
  | { workspaces?: never; error: string };

export interface WorkspaceMember {
  userId: string;
  email: string;
  fullName: string | null;
  role: string;
  isActive: boolean;
}

export type GetWorkspaceMembersResult =
  | { members: WorkspaceMember[]; error?: never }
  | { members?: never; error: string };

export type ResetMemberPasswordResult =
  | { email: string; password: string; error?: never }
  | { email?: never; password?: never; error: string };
