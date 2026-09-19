export type GenericProviderId = "openai" | `custom-${string}`;
export type SettingsProviderId = "deepseek" | "xiaomi" | "qwen" | "zhipu" | "moonshot" | GenericProviderId;
export type ProviderId = SettingsProviderId;
export function isCustomProvider(id: string): id is GenericProviderId {
  return id === "openai" || /^custom-[0-9a-f]{32}$/i.test(id);
}
