/** Display labels share the existing routes, so saved links keep working. */
export const agentOSSections = [
  { tab: "Agent", label: "Agent" },
  { tab: "Memory", label: "Memory" },
  { tab: "Assistant", label: "Assist" },
  { tab: "Workflows", label: "Tasks" },
] as const;

export function isAgentOSTab(value: unknown) {
  return agentOSSections.some((section) => section.tab === value);
}
