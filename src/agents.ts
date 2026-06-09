/**
 * Agent registry. The id maps directly to an `sbx` agent (`sbx run <agent>`). The full
 * set is whatever the installed sbx supports — discover it live with `sbx.listAgents()`
 * (this static table just supplies nice labels and a fallback). Custom/forked agents
 * (agent-kits) resolve to a title-cased label via `agentLabel()`.
 */
export interface AgentDef {
  /** sbx agent id, also used in the sandbox name. */
  id: string;
  /** Human label for terminal tabs, the form, and prompts. */
  label: string;
}

export const AGENTS: Record<string, AgentDef> = {
  claude: { id: "claude", label: "Claude" },
  codex: { id: "codex", label: "Codex" },
  copilot: { id: "copilot", label: "Copilot" },
  cursor: { id: "cursor", label: "Cursor" },
  "docker-agent": { id: "docker-agent", label: "Docker Agent" },
  droid: { id: "droid", label: "Droid" },
  gemini: { id: "gemini", label: "Gemini" },
  kiro: { id: "kiro", label: "Kiro" },
  opencode: { id: "opencode", label: "OpenCode" },
  shell: { id: "shell", label: "Shell" },
};

export const DEFAULT_AGENT = AGENTS.claude;

/** Resolve a label for any agent id (known table entry, else title-cased id). */
export function agentLabel(id: string): string {
  const known = AGENTS[id];
  if (known) {
    return known.label;
  }
  return id.charAt(0).toUpperCase() + id.slice(1);
}
