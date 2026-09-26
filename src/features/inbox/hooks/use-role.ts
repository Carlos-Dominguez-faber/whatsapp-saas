"use client";

export type WorkspaceRole = "admin" | "manager" | "agent" | "viewer";

export function canSendMessages(role: WorkspaceRole): boolean {
  return role !== "viewer";
}

export function canManageTemplates(role: WorkspaceRole): boolean {
  return role === "admin" || role === "manager";
}

export function canConfigureTools(role: WorkspaceRole): boolean {
  return role === "admin" || role === "manager";
}

export function canHandoff(role: WorkspaceRole): boolean {
  return role !== "viewer";
}

export function canTakeConversation(role: WorkspaceRole): boolean {
  return role === "agent" || role === "manager" || role === "admin";
}

// Same roles as the events SELECT policy (and /api/conversations/[id]/events).
export function canViewObservability(role: WorkspaceRole): boolean {
  return role === "admin" || role === "manager";
}
