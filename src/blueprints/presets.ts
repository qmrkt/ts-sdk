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
            system_prompt:
              'You are resolving a prediction market. Use tools when helpful, then record the best supported answer.',
            prompt:
              'Question: {{market.question}}\n' +
              'Outcomes: {{market.outcomes.indexed}}\n\n' +
              'Investigate the question, use tools if needed, then return the correct outcome index.',
            timeout_seconds: 300,
            max_steps: 8,
            max_tool_calls: 12,
            output_mode: 'resolution',
            allowed_outcomes_key: 'inputs.market.outcomes_json',
            tools: [
              {
                name: 'fetch_source',
                kind: 'builtin',
                builtin: 'source_fetch',
                description: 'Fetch a public source URL for current evidence.',
                parameters: {
                  type: 'object',
                  properties: {
                    url: { type: 'string' },
                  },
                  required: ['url'],
                },
              },
            ],
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
            prompt:
              'Question: {{market.question}}\n' +
              'Outcomes: {{market.outcomes.indexed}}\n\n' +
              'API status: {{results.fetch.status}}\n' +
              'API raw response: {{results.fetch.raw}}\n' +
              'API extracted value: {{results.fetch.json_path_value}}\n\n' +
              'Investigate the question and return the correct outcome index.',
            output_mode: 'resolution',
            allowed_outcomes_key: 'inputs.market.outcomes_json',
            timeout_seconds: 300,
            max_steps: 8,
            max_tool_calls: 12,
            tools: [
              {
                name: 'fetch_source',
                kind: 'builtin',
                builtin: 'source_fetch',
                description: 'Fetch a public source URL for current evidence.',
                parameters: {
                  type: 'object',
                  properties: {
                    url: { type: 'string' },
                  },
                  required: ['url'],
                },
              },
            ],
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

const validateBlueprintGadgetPreset: ResolutionBlueprintPreset = {
  id: 'validate_blueprint_gadget',
  name: 'Validate + gadget',
  description: 'Validate a runtime blueprint, then execute it as a child run.',
  build() {
    return createBaseBlueprint(
      'validate-blueprint-gadget',
      'Validate + Gadget',
      'Validate runtime blueprint JSON, then execute it through gadget and return the child payload.',
      [
        {
          id: 'validate',
          type: 'validate_blueprint',
          label: 'Validate Blueprint',
          position: { x: 0, y: 0 },
          config: {
            blueprint_json_key: 'inputs.dynamic_blueprint_json',
          },
        },
        {
          id: 'run',
          type: 'gadget',
          label: 'Run Gadget',
          position: { x: 320, y: -60 },
          config: {
            blueprint_json_key: 'inputs.dynamic_blueprint_json',
            timeout_seconds: 120,
            max_depth: 1,
          },
        },
        {
          id: 'invalid',
          type: 'return',
          label: 'Return Invalid',
          position: { x: 320, y: 80 },
          config: {
            value: {
              status: 'cancelled',
              reason: 'Dynamic blueprint failed validation.',
            },
          },
        },
        {
          id: 'success',
          type: 'return',
          label: 'Return Child Result',
          position: { x: 620, y: -120 },
          config: {
            from_key: 'results.run.return_json',
          },
        },
        {
          id: 'child_failed',
          type: 'return',
          label: 'Return Child Failure',
          position: { x: 620, y: 20 },
          config: {
            value: {
              status: 'cancelled',
              reason: 'Dynamic blueprint execution failed.',
            },
          },
        },
      ],
      [
        {
          from: 'validate',
          to: 'run',
          condition: "results.validate.valid == 'true'",
        },
        {
          from: 'validate',
          to: 'invalid',
          condition: "results.validate.valid != 'true'",
        },
        {
          from: 'run',
          to: 'success',
          condition: "results.run.status == 'success' && results.run.return_json != ''",
        },
        {
          from: 'run',
          to: 'child_failed',
          condition: "results.run.status != 'success' || results.run.return_json == ''",
        },
      ],
      {
        max_total_time_seconds: 600,
        max_total_tokens: 120000,
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
