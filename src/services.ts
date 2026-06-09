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

/** Resolve a ServiceDef for any service id, synthesising one for unknown/discovered ids. */
export function serviceDef(id: string): ServiceDef {
  return SERVICES[id] ?? { id, label: id };
}
