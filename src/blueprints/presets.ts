import type { ResolutionBlueprint, ResolutionBlueprintPreset, ResolutionBlueprintPresetId } from './types.js'

function createBaseBlueprint(
  id: string,
  name: string,
  description: string,
  nodes: ResolutionBlueprint['nodes'],
  edges: ResolutionBlueprint['edges'],
  budget?: ResolutionBlueprint['budget'],
): ResolutionBlueprint {
  return {
    id,
    name,
    description,
    version: 1,
    nodes,
    edges,
    budget,
  }
}

function createSourceFetchTool() {
  return {
    name: 'fetch_source',
    kind: 'builtin' as const,
    builtin: 'source_fetch' as const,
    description: 'Fetch a public source URL for current evidence.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
    },
  }
}

function createResolutionAgentSystemPrompt() {
  return (
    'You are resolving a prediction market. Choose the best investigation strategy given the market question, outcomes, deadline, and available tools. ' +
    'Gather the strongest public evidence you can find, prefer primary and recent sources when timing matters, and only return an outcome when the evidence supports it. ' +
    'If the evidence is insufficient, contradictory, or unverifiable, return inconclusive instead of guessing.'
  )
}

function createResolutionAgentPrompt(extraInstruction?: string) {
  return (
    'Question: {{market.question}}\n' +
    'Outcomes: {{market.outcomes.indexed}}\n' +
    'Resolution deadline: {{market.deadline.iso}}\n\n' +
    'Investigate this market using the best strategy you can devise. Use tools to gather evidence from public sources, follow the strongest leads, compare competing claims, and decide which outcome is best supported.\n\n' +
    'Return a structured resolution with:\n' +
    '- outcome: the winning outcome index\n' +
    '- reasoning: a concise evidence-based explanation\n' +
    '- confidence: a 0-1 confidence estimate\n\n' +
    'If the market cannot be resolved confidently from available evidence, return inconclusive.' +
    (extraInstruction ? `\n\n${extraInstruction}` : '')
  )
}

const awaitSignalPreset: ResolutionBlueprintPreset = {
  id: 'await_signal',
  name: 'Await human signal',
  description: 'Pause for a human response, then return success or cancellation.',
  build() {
    return createBaseBlueprint(
      'await-signal',
      'Await Human Signal',
      'Pause for a human resolver, then emit a terminal return payload.',
      [
        {
          id: 'review',
          type: 'await_signal',
          label: 'Human Review',
          position: { x: 0, y: 0 },
          config: {
            reason:
              'Review the market evidence, select the best supported outcome, and include a short reason.',
            signal_type: 'human_judgment.responded',
            correlation_key: 'auto',
            timeout_seconds: 172800,
            required_payload: ['outcome', 'reason'],
            timeout_outputs: {
              status: 'timeout',
            },
          },
        },
        {
          id: 'success',
          type: 'return',
          label: 'Return Success',
          position: { x: 340, y: -80 },
          config: {
            value: {
              status: 'success',
              outcome: '{{results.review.outcome}}',
              reason: '{{results.review.reason}}',
            },
          },
        },
        {
          id: 'cancelled',
          type: 'return',
          label: 'Return Cancelled',
          position: { x: 340, y: 80 },
          config: {
            value: {
              status: 'cancelled',
              reason: 'Human review was cancelled or timed out.',
            },
          },
        },
      ],
      [
        {
          from: 'review',
          to: 'success',
          condition: "results.review.status == 'responded' && results.review.outcome != ''",
        },
        {
          from: 'review',
          to: 'cancelled',
          condition:
            "results.review.status == 'cancelled' || results.review.status == 'timeout' || results.review.outcome == ''",
        },
      ],
      {
        max_total_time_seconds: 604800,
      },
    )
  },
}

const apiFetchPreset: ResolutionBlueprintPreset = {
  id: 'api_fetch',
  name: 'API fetch',
  description: 'Resolve directly from an API response using return payloads.',
  build() {
    return createBaseBlueprint(
      'api-fetch',
      'API Fetch Resolution',
      'Fetch from an API, map the result, then return success or cancellation.',
      [
        {
          id: 'fetch',
          type: 'api_fetch',
          label: 'API Fetch',
          position: { x: 0, y: 0 },
          config: {
            url: 'https://api.example.com/market-resolution',
            method: 'GET',
            headers: {},
            json_path: 'data.outcome',
            outcome_mapping: {},
            timeout_seconds: 30,
          },
        },
        {
          id: 'success',
          type: 'return',
          label: 'Return Success',
          position: { x: 320, y: -80 },
          config: {
            value: {
              status: 'success',
              outcome: '{{results.fetch.outcome}}',
            },
          },
        },
        {
          id: 'cancelled',
          type: 'return',
          label: 'Return Cancelled',
          position: { x: 320, y: 80 },
          config: {
            value: {
              status: 'cancelled',
              reason: 'API fetch did not produce a valid outcome.',
            },
          },
        },
      ],
      [
        {
          from: 'fetch',
          to: 'success',
          condition: "results.fetch.status == 'success' && results.fetch.outcome != ''",
        },
        {
          from: 'fetch',
          to: 'cancelled',
          condition: "results.fetch.status != 'success' || results.fetch.outcome == ''",
        },
      ],
      {
        max_total_time_seconds: 1800,
      },
    )
  },
}

const llmCallPreset: ResolutionBlueprintPreset = {
  id: 'llm_call',
  name: 'LLM call',
  description: 'Ask a model to resolve the question and return a terminal result.',
  build() {
    return createBaseBlueprint(
      'llm-call',
      'LLM Call Resolution',
      'Use a single model to determine the winning outcome.',
      [
        {
          id: 'judge',
          type: 'llm_call',
          label: 'LLM Call',
          position: { x: 0, y: 0 },
          config: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            prompt:
              'Question: {{market.question}}\n' +
              'Outcomes: {{market.outcomes.indexed}}\n\n' +
              'Return the correct outcome index as structured JSON.',
            allowed_outcomes_key: 'inputs.market.outcomes_json',
            timeout_seconds: 60,
          },
        },
        {
          id: 'success',
          type: 'return',
          label: 'Return Success',
          position: { x: 320, y: -80 },
          config: {
            value: {
              status: 'success',
              outcome: '{{results.judge.outcome}}',
              reasoning: '{{results.judge.reasoning}}',
              confidence: '{{results.judge.confidence}}',
            },
          },
        },
        {
          id: 'cancelled',
          type: 'return',
          label: 'Return Cancelled',
          position: { x: 320, y: 80 },
          config: {
            value: {
              status: 'cancelled',
              reason: 'LLM call was inconclusive.',
            },
          },
        },
      ],
      [
        {
          from: 'judge',
          to: 'success',
          condition:
            "results.judge.status == 'success' && results.judge.outcome != '' && results.judge.outcome != 'inconclusive'",
        },
        {
          from: 'judge',
          to: 'cancelled',
          condition:
            "results.judge.status != 'success' || results.judge.outcome == '' || results.judge.outcome == 'inconclusive'",
        },
      ],
      {
        max_total_time_seconds: 1800,
        max_total_tokens: 100000,
      },
    )
  },
}

const agentLoopPreset: ResolutionBlueprintPreset = {
  id: 'agent_loop',
  name: 'Agent loop',
  description: 'Use a tool-using agent to investigate before returning an outcome.',
  build() {
    return createBaseBlueprint(
      'agent-loop',
      'Agent Loop Resolution',
      'Run an agent loop with tools, then return success or cancellation.',
      [
        {
          id: 'agent',
          type: 'agent_loop',
          label: 'Agent Loop',
          position: { x: 0, y: 0 },
          config: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            system_prompt: createResolutionAgentSystemPrompt(),
            prompt: createResolutionAgentPrompt(),
            timeout_seconds: 300,
            max_steps: 8,
            max_tool_calls: 12,
            output_mode: 'resolution',
            allowed_outcomes_key: 'inputs.market.outcomes_json',
            tools: [createSourceFetchTool()],
          },
        },
        {
          id: 'success',
          type: 'return',
          label: 'Return Success',
          position: { x: 340, y: -80 },
          config: {
            value: {
              status: 'success',
              outcome: '{{results.agent.outcome}}',
              reasoning: '{{results.agent.reasoning}}',
              confidence: '{{results.agent.confidence}}',
            },
          },
        },
        {
          id: 'cancelled',
          type: 'return',
          label: 'Return Cancelled',
          position: { x: 340, y: 80 },
          config: {
            value: {
              status: 'cancelled',
              reason: 'Agent loop was inconclusive.',
            },
          },
        },
      ],
      [
        {
          from: 'agent',
          to: 'success',
          condition:
            "results.agent.status == 'success' && results.agent.outcome != '' && results.agent.outcome != 'inconclusive'",
        },
        {
          from: 'agent',
          to: 'cancelled',
          condition:
            "results.agent.status != 'success' || results.agent.outcome == '' || results.agent.outcome == 'inconclusive'",
        },
      ],
      {
        max_total_time_seconds: 1800,
        max_total_tokens: 140000,
      },
    )
  },
}

const yoloResolutionPreset: ResolutionBlueprintPreset = {
  id: 'yolo_resolution',
  name: 'Yolo resolution',
  description: 'Let an agent choose the best strategy, search public sources, and return the strongest supported outcome.',
  build() {
    return createBaseBlueprint(
      'yolo-resolution',
      'Yolo Resolution',
      'Run an aggressive research-oriented agent loop, then return success or cancellation.',
      [
        {
          id: 'agent',
          type: 'agent_loop',
          label: 'Yolo Agent',
          position: { x: 0, y: 0 },
          config: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            system_prompt: createResolutionAgentSystemPrompt(),
            prompt: createResolutionAgentPrompt(
              'Be proactive. Come up with the best strategy given the market conditions, feel free to search the web via public sources, branch into multiple lines of inquiry if needed, and synthesize the strongest case before choosing an outcome.',
            ),
            timeout_seconds: 420,
            tool_timeout_seconds: 25,
            max_steps: 12,
            max_tool_calls: 18,
            max_tool_result_bytes: 16000,
            tool_result_history: 3,
            max_history_messages: 32,
            max_tokens: 160000,
            output_mode: 'resolution',
            allowed_outcomes_key: 'inputs.market.outcomes_json',
            tools: [createSourceFetchTool()],
          },
        },
        {
          id: 'success',
          type: 'return',
          label: 'Return Success',
          position: { x: 340, y: -80 },
          config: {
            value: {
              status: 'success',
              outcome: '{{results.agent.outcome}}',
              reasoning: '{{results.agent.reasoning}}',
              confidence: '{{results.agent.confidence}}',
            },
          },
        },
        {
          id: 'cancelled',
          type: 'return',
          label: 'Return Cancelled',
          position: { x: 340, y: 80 },
          config: {
            value: {
              status: 'cancelled',
              reason: 'Yolo resolution was inconclusive.',
            },
          },
        },
      ],
      [
        {
          from: 'agent',
          to: 'success',
          condition:
            "results.agent.status == 'success' && results.agent.outcome != '' && results.agent.outcome != 'inconclusive'",
        },
        {
          from: 'agent',
          to: 'cancelled',
          condition:
            "results.agent.status != 'success' || results.agent.outcome == '' || results.agent.outcome == 'inconclusive'",
        },
      ],
      {
        max_total_time_seconds: 2400,
        max_total_tokens: 180000,
      },
    )
  },
}

const apiFetchWaitPreset: ResolutionBlueprintPreset = {
  id: 'api_fetch_wait',
  name: 'API fetch + wait',
  description: 'Fetch an objective outcome, wait briefly, then return it.',
  build() {
    return createBaseBlueprint(
      'api-fetch-wait',
      'API Fetch + Wait',
      'Use a deterministic fetch, delay, then emit the final return payload.',
      [
        {
          id: 'fetch',
          type: 'api_fetch',
          label: 'API Fetch',
          position: { x: 0, y: 0 },
          config: {
            url: 'https://api.example.com/market-resolution',
            method: 'GET',
            headers: {},
            json_path: 'data.outcome',
            outcome_mapping: {},
            timeout_seconds: 30,
          },
        },
        {
          id: 'wait',
          type: 'wait',
          label: 'Wait',
          position: { x: 320, y: -48 },
          config: {
            duration_seconds: 300,
            mode: 'sleep',
          },
        },
        {
          id: 'success',
          type: 'return',
          label: 'Return Success',
          position: { x: 620, y: -48 },
          config: {
            value: {
              status: 'success',
              outcome: '{{results.fetch.outcome}}',
            },
          },
        },
        {
          id: 'cancelled',
          type: 'return',
          label: 'Return Cancelled',
          position: { x: 320, y: 112 },
          config: {
            value: {
              status: 'cancelled',
              reason: 'API fetch failed before the wait gate.',
            },
          },
        },
      ],
      [
        {
          from: 'fetch',
          to: 'wait',
          condition: "results.fetch.status == 'success' && results.fetch.outcome != ''",
        },
        {
          from: 'fetch',
          to: 'cancelled',
          condition: "results.fetch.status != 'success' || results.fetch.outcome == ''",
        },
        { from: 'wait', to: 'success' },
      ],
      {
        max_total_time_seconds: 3600,
      },
    )
  },
}

const apiFetchAgentLoopPreset: ResolutionBlueprintPreset = {
  id: 'api_fetch_agent_loop',
  name: 'API fetch + agent fallback',
  description: 'Try a deterministic API path first, then escalate to an agent loop.',
  build() {
    return createBaseBlueprint(
      'api-fetch-agent-loop',
      'API Fetch + Agent Fallback',
      'Use API fetch first and escalate to an agent loop when the API path is insufficient.',
      [
        {
          id: 'fetch',
          type: 'api_fetch',
          label: 'API Fetch',
          position: { x: 0, y: 0 },
          config: {
            url: 'https://api.example.com/market-resolution',
            method: 'GET',
            headers: {},
            json_path: 'data.outcome',
            outcome_mapping: {},
            timeout_seconds: 30,
          },
        },
        {
          id: 'agent',
          type: 'agent_loop',
          label: 'Agent Fallback',
          position: { x: 320, y: 84 },
          config: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            system_prompt: createResolutionAgentSystemPrompt(),
            prompt: createResolutionAgentPrompt(
              'The deterministic API path did not produce a reliable answer.\n' +
                'API status: {{results.fetch.status}}\n' +
                'API raw response: {{results.fetch.raw}}\n' +
                'API extracted value: {{results.fetch.json_path_value}}\n\n' +
                'Recover by investigating with public evidence and return the strongest supported outcome.',
            ),
            output_mode: 'resolution',
            allowed_outcomes_key: 'inputs.market.outcomes_json',
            timeout_seconds: 300,
            max_steps: 8,
            max_tool_calls: 12,
            tools: [createSourceFetchTool()],
          },
        },
        {
          id: 'success',
          type: 'return',
          label: 'Return Success',
          position: { x: 660, y: -84 },
          config: {
            value: {
              status: 'success',
              outcome: '{{results.fetch.outcome}}',
            },
          },
        },
        {
          id: 'agent_success',
          type: 'return',
          label: 'Return Agent Success',
          position: { x: 660, y: 48 },
          config: {
            value: {
              status: 'success',
              outcome: '{{results.agent.outcome}}',
              reasoning: '{{results.agent.reasoning}}',
            },
          },
        },
        {
          id: 'cancelled',
          type: 'return',
          label: 'Return Cancelled',
          position: { x: 660, y: 180 },
          config: {
            value: {
              status: 'cancelled',
              reason: 'Neither the API path nor the agent fallback produced a valid outcome.',
            },
          },
        },
      ],
      [
        {
          from: 'fetch',
          to: 'success',
          condition: "results.fetch.status == 'success' && results.fetch.outcome != ''",
        },
        {
          from: 'fetch',
          to: 'agent',
          condition: "results.fetch.status != 'success' || results.fetch.outcome == ''",
        },
        {
          from: 'agent',
          to: 'agent_success',
          condition:
            "results.agent.status == 'success' && results.agent.outcome != '' && results.agent.outcome != 'inconclusive'",
        },
        {
          from: 'agent',
          to: 'cancelled',
          condition:
            "results.agent.status != 'success' || results.agent.outcome == '' || results.agent.outcome == 'inconclusive'",
        },
      ],
      {
        max_total_time_seconds: 2400,
        max_total_tokens: 140000,
      },
    )
  },
}

// YOLO auto-resolution with adversarial review.
//
// A three-agent pipeline that drafts a child resolution blueprint, has a
// separate model red-team and strengthen it, validates the candidate
// against the runtime policy, attempts a bounded repair on failure, then
// executes the final child blueprint through `gadget`. Mirrors the
// reference `yolo-auto-resolution` example in the blueprint engine docs
// and defers (rather than guesses) when the child cannot produce a
// bounded resolution.
const YOLO_DRAFT_PROMPT =
  'Draft a minimal, well-bounded child resolution blueprint for this prediction market.\n\n' +
  'Question: {{inputs.market.question}}\n' +
  'Outcomes JSON: {{inputs.market.outcomes_json}}\n' +
  'Resolution rules: {{inputs.market.resolution_rules}}\n' +
  'Live context JSON: {{inputs.market.context_json}}\n' +
  'Suggested sources JSON: {{inputs.market.sources_json}}\n' +
  'Allowed child node types JSON: {{inputs.yolo.allowed_node_types_json}}\n' +
  'Example catalog JSON: {{inputs.yolo.examples_json}}\n' +
  'Source pack catalog JSON: {{inputs.yolo.source_packs_json}}\n\n' +
  'Design principles — follow all:\n' +
  ' 1. Prefer primary, authoritative sources over aggregators.\n' +
  ' 2. Use redundancy when a single source could be wrong or unavailable.\n' +
  ' 3. Keep the graph small and bounded: <= 12 nodes, <= 18 edges, <= 1 depth.\n' +
  ' 4. End with a `return` node whose payload is {status, outcome?, reason?}.\n' +
  ' 5. Defer with status=deferred rather than guess when evidence is weak.\n\n' +
  'Return the full child blueprint as a JSON string in `blueprint_json`. ' +
  'Include a one-line `strategy_summary` and the `assumptions` you are making about the question.'

const YOLO_REDTEAM_PROMPT =
  'Red-team and strengthen the drafted child blueprint. Assume it is WRONG until proven safe.\n\n' +
  'Question: {{inputs.market.question}}\n' +
  'Outcomes JSON: {{inputs.market.outcomes_json}}\n' +
  'Resolution rules: {{inputs.market.resolution_rules}}\n' +
  'Draft blueprint JSON: {{results.draft.output.blueprint_json}}\n' +
  'Draft notes JSON: {{results.draft.output_json}}\n\n' +
  'Adversarial checklist — for each, strengthen the blueprint if the issue applies:\n' +
  ' 1. Single-point-of-failure sources: add redundancy or cross-checks.\n' +
  ' 2. Ambiguous outcome mapping: add explicit CEL that eliminates ties.\n' +
  ' 3. Premature certainty: widen thresholds that would trigger `outcome` over `deferred`.\n' +
  ' 4. Stale data / timing edge cases around the deadline: add recency checks.\n' +
  ' 5. Missing deferral paths: every fetch/LLM call should have a deferred fallback edge.\n' +
  ' 6. Node-count and depth: keep <= 12 nodes / <= 18 edges / <= 1 depth.\n\n' +
  'Rewrite the blueprint to fix everything you found. Return the full revised child blueprint JSON ' +
  'as `blueprint_json`, a concise `attack_summary`, and any `residual_risks` you could not remove.'

const YOLO_REPAIR_PROMPT =
  'Repair this child resolution blueprint so it passes the runtime validator. Change as little as possible.\n\n' +
  'Question: {{inputs.market.question}}\n' +
  'Outcomes JSON: {{inputs.market.outcomes_json}}\n' +
  'Current child blueprint JSON: {{results.candidate.blueprint_json}}\n' +
  'Validator issues JSON: {{results.validate.issues_json}}\n' +
  'Validator issues text:\n{{results.validate.issues_text}}\n\n' +
  'Rules:\n' +
  ' - Preserve the existing deferral paths; do not remove conservative fallbacks.\n' +
  ' - Keep node and edge counts at or below the original.\n' +
  ' - Do not add new tool types or widen the policy envelope.\n\n' +
  'Return the full repaired child blueprint JSON string as `blueprint_json` and a short `repair_notes` list.'

const validateBlueprintGadgetPreset: ResolutionBlueprintPreset = {
  id: 'validate_blueprint_gadget',
  name: 'YOLO Auto Resolution',
  description:
    'Let an agent draft a resolution blueprint, red-team it with a second model, validate + repair, then execute it.',
  build() {
    return createBaseBlueprint(
      'yolo-auto-resolution',
      'YOLO Auto Resolution',
      'Draft → red-team → validate → repair → gadget. Defers rather than guessing when the child blueprint is not bounded or cannot be validated.',
      [
        {
          id: 'draft',
          type: 'agent_loop',
          label: 'Draft Blueprint',
          position: { x: 0, y: 0 },
          config: {
            provider: 'openai',
            model: 'gpt-5.4',
            output_mode: 'structured',
            max_steps: 8,
            max_tool_calls: 6,
            prompt: YOLO_DRAFT_PROMPT,
            output_tool: {
              parameters: {
                type: 'object',
                properties: {
                  blueprint_json: { type: 'string' },
                  strategy_summary: { type: 'string' },
                  assumptions: { type: 'array', items: { type: 'string' } },
                },
                required: ['blueprint_json', 'strategy_summary'],
              },
            },
          },
        },
        {
          id: 'redteam',
          type: 'agent_loop',
          label: 'Red-team & Harden',
          position: { x: 320, y: 0 },
          config: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            output_mode: 'structured',
            max_steps: 8,
            max_tool_calls: 6,
            prompt: YOLO_REDTEAM_PROMPT,
            output_tool: {
              parameters: {
                type: 'object',
                properties: {
                  blueprint_json: { type: 'string' },
                  attack_summary: { type: 'string' },
                  residual_risks: { type: 'array', items: { type: 'string' } },
                },
                required: ['blueprint_json', 'attack_summary'],
              },
            },
          },
        },
        {
          id: 'candidate',
          type: 'cel_eval',
          label: 'Pick Candidate',
          position: { x: 620, y: 0 },
          config: {
            expressions: {
              blueprint_json:
                "results.repair.output_json.blueprint_json != '' ? results.repair.output_json.blueprint_json : results.redteam.output_json.blueprint_json",
              source:
                "results.repair.output_json.blueprint_json != '' ? 'repair' : 'redteam'",
            },
          },
        },
        {
          id: 'validate',
          type: 'validate_blueprint',
          label: 'Validate',
          position: { x: 920, y: 0 },
          config: {
            blueprint_json_key: 'results.candidate.blueprint_json',
          },
        },
        {
          id: 'repair',
          type: 'agent_loop',
          label: 'Repair Blueprint',
          position: { x: 920, y: 160 },
          config: {
            provider: 'openai',
            model: 'gpt-5.4-mini',
            output_mode: 'structured',
            max_steps: 6,
            max_tool_calls: 4,
            prompt: YOLO_REPAIR_PROMPT,
            output_tool: {
              parameters: {
                type: 'object',
                properties: {
                  blueprint_json: { type: 'string' },
                  repair_notes: { type: 'array', items: { type: 'string' } },
                },
                required: ['blueprint_json'],
              },
            },
          },
        },
        {
          id: 'run_child',
          type: 'gadget',
          label: 'Execute Child',
          position: { x: 1240, y: -80 },
          config: {
            blueprint_json_key: 'results.candidate.blueprint_json',
            timeout_seconds: 600,
            max_depth: 1,
            input_mappings: {
              'market.question': 'inputs.market.question',
              'market.outcomes_json': 'inputs.market.outcomes_json',
              'market.resolution_rules': 'inputs.market.resolution_rules',
              'market.context_json': 'inputs.market.context_json',
              'market.sources_json': 'inputs.market.sources_json',
            },
            dynamic_blueprint_policy: {
              allowed_node_types: [
                'api_fetch',
                'llm_call',
                'agent_loop',
                'wait',
                'return',
                'cel_eval',
                'map',
              ],
              max_nodes: 16,
              max_edges: 24,
              max_depth: 1,
              max_total_time_seconds: 600,
              max_total_tokens: 120000,
              allow_agent_loop: true,
            },
          },
        },
        {
          id: 'return_result',
          type: 'return',
          label: 'Return Child Result',
          position: { x: 1560, y: -160 },
          config: {
            from_key: 'results.run_child.return_json',
          },
        },
        {
          id: 'defer_runtime',
          type: 'return',
          label: 'Defer (runtime)',
          position: { x: 1560, y: 0 },
          config: {
            value: {
              status: 'deferred',
              reason: 'The generated child blueprint did not produce a conclusive bounded resolution.',
            },
          },
        },
        {
          id: 'defer_invalid',
          type: 'return',
          label: 'Defer (invalid)',
          position: { x: 1240, y: 240 },
          config: {
            value: {
              status: 'deferred',
              reason: 'The generated child blueprint could not be validated within the repair budget.',
            },
          },
        },
      ],
      [
        { from: 'draft', to: 'redteam' },
        { from: 'redteam', to: 'candidate' },
        { from: 'candidate', to: 'validate' },
        {
          from: 'validate',
          to: 'run_child',
          condition: "results.validate.valid == 'true'",
        },
        {
          from: 'validate',
          to: 'repair',
          condition: "results.validate.valid != 'true' && size(results.validate.history) < 2",
        },
        { from: 'repair', to: 'candidate', max_traversals: 2 },
        {
          from: 'validate',
          to: 'defer_invalid',
          condition: "results.validate.valid != 'true' && size(results.validate.history) >= 2",
        },
        {
          from: 'run_child',
          to: 'return_result',
          condition:
            "results.run_child.status == 'success' && results.run_child.run_status == 'completed'",
        },
        {
          from: 'run_child',
          to: 'defer_runtime',
          condition:
            "results.run_child.status != 'success' || results.run_child.run_status != 'completed'",
        },
      ],
      {
        max_total_time_seconds: 2400,
        max_total_tokens: 240000,
      },
    )
  },
}

export const RESOLUTION_BLUEPRINT_PRESETS: Record<
  ResolutionBlueprintPresetId,
  ResolutionBlueprintPreset
> = {
  await_signal: awaitSignalPreset,
  api_fetch: apiFetchPreset,
  llm_call: llmCallPreset,
  agent_loop: agentLoopPreset,
  yolo_resolution: yoloResolutionPreset,
  api_fetch_wait: apiFetchWaitPreset,
  api_fetch_agent_loop: apiFetchAgentLoopPreset,
  validate_blueprint_gadget: validateBlueprintGadgetPreset,
}

export function getResolutionBlueprintPreset(id: ResolutionBlueprintPresetId): ResolutionBlueprintPreset {
  return RESOLUTION_BLUEPRINT_PRESETS[id]
}

export function buildResolutionBlueprintPreset(id: ResolutionBlueprintPresetId): ResolutionBlueprint {
  return getResolutionBlueprintPreset(id).build()
}
