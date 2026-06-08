/**
 * Agent registry. The id maps directly to an `sbx` agent
 * (sbx run <agent>): claude, codex, gemini, copilot, cursor, shell, ...
 * The MVP surfaces Claude; the rest plug in by adding entries here.
 */
export interface AgentDef {
  /** sbx agent id, also used in the sandbox name. */
  id: string;
  /** Human label for terminal tabs and prompts. */
  label: string;
}

export const AGENTS: Record<string, AgentDef> = {
  claude: { id: "claude", label: "Claude" },
};

export const DEFAULT_AGENT = AGENTS.claude;
