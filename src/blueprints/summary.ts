import { getNodeCapability } from './capabilities.js'
import { compileResolutionBlueprint } from './compiler.js'
import { describeLLMSelection } from './llm-models.js'
import type {
  CompiledResolutionBlueprint,
  MarketTemplateContext,
  ResolutionBlueprint,
  ResolutionBlueprintNodeDef,
  ResolutionTrustClass,
} from './types.js'

function truncateAddress(addr: string, prefix = 6, suffix = 4): string {
  if (addr.length <= prefix + suffix + 3) return addr
  return `${addr.slice(0, prefix)}...${addr.slice(-suffix)}`
}

export function getNodeDisplayLabel(
  node: ResolutionBlueprintNodeDef | null | undefined
): string {
  if (!node) return "Unnamed step";
  return (
    node.label?.trim() || getNodeCapability(node.type)?.label || "Unnamed step"
  );
}

export function formatWaitDuration(config: { duration_seconds: number; mode?: string; start_from?: string }): string {
  const secs = Math.max(0, Number(config.duration_seconds) || 0);
  if (config.mode === "defer") {
    const anchor =
      config.start_from === "resolution_pending_since"
        ? "resolution pending"
        : config.start_from === "deadline"
        ? "deadline"
        : "start";
    return `${secs}s from ${anchor}`;
  }
  return `${secs}s delay`;
}

export function summarizeNode(node: ResolutionBlueprintNodeDef): string {
  switch (node.type) {
    case "api_fetch":
      return node.config.url?.trim()
        ? new URL(
            node.config.url,
            "https://placeholder.invalid"
          ).hostname.replace("placeholder.invalid", "custom API")
        : "Fetch endpoint";
    case "market_evidence":
      return "Participant evidence bundle";
    case "llm_judge":
      return describeLLMSelection(node.config);
    case "human_judge": {
      let who: string;
      if (node.config.designated_address?.trim()) {
        who = `Await ${truncateAddress(node.config.designated_address)}`;
      } else {
        who =
          node.config.allowed_responders.length > 0
            ? `Await ${node.config.allowed_responders.join(" + ")}`
            : "Await human resolver";
      }
      const timeout = Number(node.config.timeout_seconds || 0);
      if (timeout > 0) {
        const h = Math.round(timeout / 3600);
        return `${who} (${h}h timeout)`;
      }
      return who;
    }
    case "wait":
      return formatWaitDuration(node.config);
    case "defer_resolution":
      return node.config.reason?.trim() || "Retry later";
    case "submit_result":
      return node.config.outcome_key?.trim() || "Auto-detect outcome";
    case "cancel_market":
      return node.config.reason?.trim() || "Cancel on failure";
  }
}

export function deriveTrustClass(
  blueprint: ResolutionBlueprint
): ResolutionTrustClass {
  if (blueprint.nodes.some((node) => node.type === "human_judge")) {
    return "human_judged";
  }
  if (blueprint.nodes.some((node) => node.type === "llm_judge")) {
    return "agent_assisted";
  }
  return "objective";
}

export function summarizeTerminalActions(
  blueprint: ResolutionBlueprint
): string {
  const terminals = blueprint.nodes.filter(
    (node) =>
      node.type === "submit_result" ||
      node.type === "cancel_market" ||
      node.type === "defer_resolution"
  );
  if (terminals.length === 0) {
    return "No terminal action";
  }

  const labels = terminals.map((node) => getNodeCapability(node.type).label);
  return Array.from(new Set(labels)).join(" + ");
}

export function estimateCompiledBlueprint(
  blueprint: ResolutionBlueprint,
  market: MarketTemplateContext
): CompiledResolutionBlueprint | null {
  try {
    return compileResolutionBlueprint(blueprint, market);
  } catch {
    return null;
  }
}
