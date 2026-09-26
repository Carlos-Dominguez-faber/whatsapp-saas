"use server";

import { appendFile, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

const FEEDBACK_FILE = join(process.cwd(), "UI_FEEDBACK.md");
const HEADER =
  "# UI Feedback\n\nNotas para mejorar el Component Showcase.\n" +
  "Claude Code lee este archivo en el próximo /add-ui-kit y propone los cambios.\n\n---\n";

// These are Server Actions, so they stay reachable over HTTP even though the
// /ui page renders nothing in production. They write a file that Claude Code
// reads later, so outside local development they refuse to run at all.
function assertDevelopment() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("UI feedback is only available in development");
  }
}

export async function saveFeedback(
  section: string,
  feedback: string,
  agentationNotes?: string,
) {
  assertDevelopment();
  if (!existsSync(FEEDBACK_FILE)) {
    await writeFile(FEEDBACK_FILE, HEADER, "utf-8");
  }
  const timestamp = new Date().toLocaleString("es-MX", {
    timeZone: "America/Mexico_City",
    dateStyle: "short",
    timeStyle: "short",
  });
  const agentationBlock = agentationNotes?.trim()
    ? `\n**Anotaciones Agentation:**\n\`\`\`\n${agentationNotes.trim()}\n\`\`\`\n`
    : "";
  const entry = `\n## ${section}\n**Fecha:** ${timestamp}  \n**Feedback:** ${feedback}${agentationBlock}\n---\n`;
  await appendFile(FEEDBACK_FILE, entry, "utf-8");
}

export async function getFeedback(): Promise<string> {
  assertDevelopment();
  if (!existsSync(FEEDBACK_FILE)) return "";
  return readFile(FEEDBACK_FILE, "utf-8");
}

export async function clearFeedback() {
  assertDevelopment();
  await writeFile(FEEDBACK_FILE, HEADER, "utf-8");
}
