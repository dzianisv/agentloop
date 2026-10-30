/** One ordered subscription roster; only these models can be selected automatically. */
export type SupervisorRole = "planner" | "implementer" | "reviewer";
export type CredentialSlot = "openrouter-1" | "openrouter-2";
export type SubscriptionGroupId = "opencode" | CredentialSlot | "chatgpt";
export type ModelCandidate = {
  groupId: SubscriptionGroupId;
  providerId: "openai" | "opencode" | "openrouter" | "openrouter-2";
  modelId: string;
  credentialSlot?: CredentialSlot;
  reasoning: string;
  auth: "chatgpt-oauth" | "zen-free" | "openrouter-free";
};

type RoleModel = { modelId: string; reasoning: "max" | "high" };
type SubscriptionGroup = {
  id: SubscriptionGroupId;
  providerId: ModelCandidate["providerId"];
  auth: ModelCandidate["auth"];
  credentialSlot?: CredentialSlot;
  roles: Partial<Record<SupervisorRole, readonly RoleModel[]>>;
};

const subscriptionGroups: readonly SubscriptionGroup[] = [
  {
    id: "opencode", providerId: "opencode", auth: "zen-free",
    roles: {
      planner: [{ modelId: "glm-5.3-flash-free", reasoning: "max" }],
      implementer: [{ modelId: "deepseek-v4.1-flash-free", reasoning: "max" }],
      reviewer: [{ modelId: "glm-5.3-flash-free", reasoning: "max" }],
    },
  },
  {
    id: "openrouter-1", providerId: "openrouter", auth: "openrouter-free", credentialSlot: "openrouter-1",
    roles: {
      planner: [{ modelId: "nvidia/nemotron-3.5-super-vl:free", reasoning: "high" }],
      implementer: [{ modelId: "nvidia/nemotron-3.5-super-vl:free", reasoning: "high" }],
      reviewer: [{ modelId: "nvidia/nemotron-3.5-super-vl:free", reasoning: "high" }],
    },
  },
  {
    // This identity is usable only when the shared OpenCode server already has
    // a separately configured provider alias. We never inject or rotate keys.
    id: "openrouter-2", providerId: "openrouter-2", auth: "openrouter-free", credentialSlot: "openrouter-2",
    roles: {
      planner: [{ modelId: "nvidia/nemotron-3.5-super-vl:free", reasoning: "high" }],
      implementer: [{ modelId: "nvidia/nemotron-3.5-super-vl:free", reasoning: "high" }],
      reviewer: [{ modelId: "nvidia/nemotron-3.5-super-vl:free", reasoning: "high" }],
    },
  },
  {
    id: "chatgpt", providerId: "openai", auth: "chatgpt-oauth",
    roles: {
      planner: [{ modelId: "gpt-6.1-sol", reasoning: "max" }],
      implementer: [{ modelId: "gpt-6-luna", reasoning: "max" }],
      reviewer: [
        { modelId: "gpt-6-astra", reasoning: "max" },
        { modelId: "gpt-6.1-sol", reasoning: "max" },
      ],
    },
  },
];

export const SUBSCRIPTION_GROUP_ORDER: readonly SubscriptionGroupId[] = subscriptionGroups.map(group => group.id);

/** Provider/free aliases compare by normalized model name, as in the legacy safeguards. */
export function normalizedModelIdentity(providerId: string, modelId: string): string {
  const model = modelId.split("/").at(-1) ?? modelId;
  return model.replace(/(?::free|-free)$/, "");
}

export function candidatesForRole(role: SupervisorRole, exclude?: { providerId: string; modelId: string }): ModelCandidate[] {
  const excluded = exclude ? normalizedModelIdentity(exclude.providerId, exclude.modelId) : undefined;
  return subscriptionGroups.flatMap(group => (group.roles[role] || []).map(model => ({
    groupId: group.id, providerId: group.providerId, modelId: model.modelId, reasoning: model.reasoning,
    auth: group.auth, ...(group.credentialSlot ? { credentialSlot: group.credentialSlot } : {}),
  }))).filter(candidate =>
    !excluded || normalizedModelIdentity(candidate.providerId, candidate.modelId) !== excluded,
  );
}
