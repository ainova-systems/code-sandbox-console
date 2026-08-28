/**
 * Service secrets sbx can provision (`sbx secret set`). Drives the Secrets tab of the
 * create/edit form (FR-032). The live set is whatever the installed sbx supports —
 * discover with `sbx.listSecretServices()`; this table supplies labels + a fallback.
 */
export interface ServiceDef {
  id: string;
  label: string;
  /** `sbx secret set --oauth` is available (currently openai/global only). */
  oauth?: boolean;
}

export const SERVICES: Record<string, ServiceDef> = {
  anthropic: { id: "anthropic", label: "Anthropic" },
  openai: { id: "openai", label: "OpenAI", oauth: true },
  github: { id: "github", label: "GitHub" },
  google: { id: "google", label: "Google" },
  aws: { id: "aws", label: "AWS" },
  bedrock: { id: "bedrock", label: "AWS Bedrock" },
  cursor: { id: "cursor", label: "Cursor" },
  droid: { id: "droid", label: "Droid" },
  groq: { id: "groq", label: "Groq" },
  mistral: { id: "mistral", label: "Mistral" },
  nebius: { id: "nebius", label: "Nebius" },
  xai: { id: "xai", label: "xAI" },
};

export function serviceLabel(id: string): string {
  return SERVICES[id]?.label ?? id;
}

/**
 * FR-032: a stored API-key secret that collides with an agent's own sign-in. The host
 * proxy prefers the stored secret, so the agent still prompts to log in and the loop
 * never completes. Cursor is the known case (docker/sbx-releases#112); GitHub and other
 * secrets on a Cursor sandbox are fine, and other agents may still pick a Cursor key.
 */
export interface SecretConflict {
  agent: string;
  service: string;
  reason: string;
}

export const SECRET_CONFLICTS: SecretConflict[] = [
  {
    agent: "cursor",
    service: "cursor",
    reason:
      "Cursor signs in from the terminal. A Cursor API key takes precedence over that flow and is rejected inside the sandbox.",
  },
];

export function isConflictingSecret(agent: string, service: string): boolean {
  return SECRET_CONFLICTS.some(
    (c) => c.agent === agent && c.service === service
  );
}
