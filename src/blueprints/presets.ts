import type { ResolutionBlueprint, ResolutionBlueprintPreset, ResolutionBlueprintPresetId } from './types'

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

const humanJudgePreset: ResolutionBlueprintPreset = {
  id: 'human_judge',
  name: 'Human judge',
  description: 'Let the market creator or protocol admin resolve the market directly.',
  build() {
    return createBaseBlueprint(
      'human-judge',
      'Human Judge Resolution',
      'Pause for a trusted human resolver, then submit the selected outcome.',
      [
        {
          id: 'judge',
          type: 'human_judge',
          label: 'Human Judge',
          position: { x: 0, y: 0 },
          config: {
            prompt:
              'Question: {{market.question}}\n' +
              'Outcomes: {{market.outcomes.indexed}}\n\n' +
              'Select the correct outcome index for this market.',
            allowed_responders: ['creator', 'protocol_admin'],
            timeout_seconds: 172800,
            require_reason: true,
            allow_cancel: true,
          },
        },
        {
          id: 'submit',
          type: 'submit_result',
          label: 'Submit',
          position: { x: 320, y: -80 },
          config: {
            outcome_key: 'judge.outcome',
          },
        },
        {
          id: 'cancel',
          type: 'cancel_market',
          label: 'Cancel',
          position: { x: 320, y: 80 },
          config: {
            reason: 'Human judge cancelled or timed out',
          },
        },
      ],
      [
        { from: 'judge', to: 'submit', condition: "judge.status == 'responded' && judge.outcome != ''" },
        { from: 'judge', to: 'cancel', condition: "judge.status == 'cancelled' || judge.status == 'timeout'" },
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
  description: 'Resolve directly from an API response with cancellation on failure.',
  build() {
    return createBaseBlueprint(
      'api-fetch',
      'API Fetch Resolution',
      'Fetch from an API, map the result, then submit.',
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
          id: 'submit',
          type: 'submit_result',
          label: 'Submit',
          position: { x: 300, y: -84 },
          config: {
            outcome_key: 'fetch.outcome',
          },
        },
        {
          id: 'cancel',
          type: 'cancel_market',
          label: 'Cancel',
          position: { x: 300, y: 84 },
          config: {
            reason: 'API fetch did not produce a valid outcome',
          },
        },
      ],
      [
        { from: 'fetch', to: 'submit', condition: "fetch.status == 'success' && fetch.outcome != ''" },
        { from: 'fetch', to: 'cancel', condition: "fetch.status != 'success' || fetch.outcome == ''" },
      ],
      {
        max_total_time_seconds: 1800,
      },
    )
  },
}

const llmJudgePreset: ResolutionBlueprintPreset = {
  id: 'llm_judge',
  name: 'LLM judge',
  description: 'Ask a model to resolve the question directly and cancel if inconclusive.',
  build() {
    return createBaseBlueprint(
      'llm-judge',
      'LLM Judge Resolution',
      'Use a single model to determine the winning outcome.',
      [
        {
          id: 'judge',
          type: 'llm_judge',
          label: 'LLM Judge',
          position: { x: 0, y: 0 },
          config: {
            provider: 'anthropic',
            prompt:
              'Question: {{market.question}}\n' +
              'Outcomes: {{market.outcomes.indexed}}\n\n' +
              'Return the correct outcome index as structured JSON.',
            model: 'claude-sonnet-4-6',
            timeout_seconds: 60,
          },
        },
        {
          id: 'submit',
          type: 'submit_result',
          label: 'Submit',
          position: { x: 300, y: -84 },
          config: {
            outcome_key: 'judge.outcome',
          },
        },
        {
          id: 'cancel',
          type: 'cancel_market',
          label: 'Cancel',
          position: { x: 300, y: 84 },
          config: {
            reason: 'LLM judge was inconclusive',
          },
        },
      ],
      [
        { from: 'judge', to: 'submit', condition: "judge.outcome != 'inconclusive' && judge.outcome != ''" },
        { from: 'judge', to: 'cancel', condition: "judge.outcome == 'inconclusive' || judge.outcome == ''" },
      ],
      {
        max_total_time_seconds: 1800,
        max_total_tokens: 100000,
      },
    )
  },
}

const apiFetchLLMPreset: ResolutionBlueprintPreset = {
  id: 'api_fetch_llm',
  name: 'API fetch + LLM fallback',
  description: 'Try a deterministic API path first, then ask a model if the fetch fails.',
  build() {
    return createBaseBlueprint(
      'api-fetch-llm',
      'API Fetch + LLM Fallback',
      'Use API fetch first and escalate to an LLM judge when the API path is insufficient.',
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
          id: 'judge',
          type: 'llm_judge',
          label: 'LLM Fallback',
          position: { x: 300, y: 84 },
          config: {
            provider: 'anthropic',
            prompt:
              'Question: {{market.question}}\n' +
              'Outcomes: {{market.outcomes.indexed}}\n\n' +
              'API status: {{fetch.status}}\n' +
              'API response: {{fetch.raw}}\n' +
              'API extracted value: {{fetch.extracted}}\n\n' +
              'Use the API response if it is informative and return the correct outcome index as structured JSON.',
            model: 'claude-sonnet-4-6',
            timeout_seconds: 60,
          },
        },
        {
          id: 'submit',
          type: 'submit_result',
          label: 'Submit',
          position: { x: 620, y: -84 },
          config: {
            outcome_key: 'fetch.outcome',
          },
        },
        {
          id: 'fallback_submit',
          type: 'submit_result',
          label: 'Submit Fallback',
          position: { x: 620, y: 48 },
          config: {
            outcome_key: 'judge.outcome',
          },
        },
        {
          id: 'cancel',
          type: 'cancel_market',
          label: 'Cancel',
          position: { x: 620, y: 180 },
          config: {
            reason: 'Neither the API nor the fallback judge produced a valid outcome',
          },
        },
      ],
      [
        { from: 'fetch', to: 'submit', condition: "fetch.status == 'success' && fetch.outcome != ''" },
        { from: 'fetch', to: 'judge', condition: "fetch.status != 'success' || fetch.outcome == ''" },
        { from: 'judge', to: 'fallback_submit', condition: "judge.outcome != 'inconclusive' && judge.outcome != ''" },
        { from: 'judge', to: 'cancel', condition: "judge.outcome == 'inconclusive' || judge.outcome == ''" },
      ],
      {
        max_total_time_seconds: 1800,
        max_total_tokens: 100000,
      },
    )
  },
}

const apiFetchWaitPreset: ResolutionBlueprintPreset = {
  id: 'api_fetch_wait',
  name: 'API fetch + wait',
  description: 'Fetch an objective outcome, wait a short window, then submit.',
  build() {
    return createBaseBlueprint(
      'api-fetch-wait',
      'API Fetch + Wait',
      'Use a deterministic fetch, delay, then submit the result.',
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
          position: { x: 300, y: -48 },
          config: {
            duration_seconds: 300,
          },
        },
        {
          id: 'submit',
          type: 'submit_result',
          label: 'Submit',
          position: { x: 600, y: -48 },
          config: {
            outcome_key: 'fetch.outcome',
          },
        },
        {
          id: 'cancel',
          type: 'cancel_market',
          label: 'Cancel',
          position: { x: 300, y: 112 },
          config: {
            reason: 'API fetch failed before the wait gate',
          },
        },
      ],
      [
        { from: 'fetch', to: 'wait', condition: "fetch.status == 'success' && fetch.outcome != ''" },
        { from: 'fetch', to: 'cancel', condition: "fetch.status != 'success' || fetch.outcome == ''" },
        { from: 'wait', to: 'submit' },
      ],
      {
        max_total_time_seconds: 3600,
      },
    )
  },
}

const participantEvidenceLLMPreset: ResolutionBlueprintPreset = {
  id: 'participant_evidence_llm',
  name: 'Participant evidence + LLM',
  description: 'Collect signed participant evidence for 12 hours, then ask a model to resolve.',
  build() {
    return createBaseBlueprint(
      'participant-evidence-llm',
      'Participant Evidence + LLM',
      'Wait for the evidence window to close, load participant submissions, then judge with an LLM.',
      [
        {
          id: 'wait',
          type: 'wait',
          label: 'Evidence Window',
          position: { x: 0, y: 0 },
          config: {
            duration_seconds: 43200,
            mode: 'defer',
            start_from: 'resolution_pending_since',
          },
        },
        {
          id: 'defer',
          type: 'defer_resolution',
          label: 'Retry Later',
          position: { x: 320, y: -96 },
          config: {
            reason: 'Evidence window still open',
          },
        },
        {
          id: 'evidence',
          type: 'market_evidence',
          label: 'Participant Evidence',
          position: { x: 320, y: 48 },
          config: {},
        },
        {
          id: 'judge',
          type: 'llm_judge',
          label: 'LLM Judge',
          position: { x: 640, y: 48 },
          config: {
            prompt:
              'Question: {{market.question}}\n' +
              'Outcomes: {{market.outcomes.indexed}}\n' +
              'Participant evidence count: {{evidence.count}}\n' +
              'Claimed outcome summary: {{evidence.claimed_summary}}\n\n' +
              'Participant evidence entries JSON:\n{{evidence.entries_json}}\n\n' +
              'Use the participant evidence bundle to determine the correct outcome index. ' +
              'If the evidence is insufficient or contradictory, return inconclusive.',
            model: 'claude-sonnet-4-6',
            timeout_seconds: 60,
          },
        },
        {
          id: 'submit',
          type: 'submit_result',
          label: 'Submit',
          position: { x: 960, y: -24 },
          config: {
            outcome_key: 'judge.outcome',
          },
        },
        {
          id: 'cancel',
          type: 'cancel_market',
          label: 'Cancel',
          position: { x: 960, y: 120 },
          config: {
            reason: 'Participant evidence judge was inconclusive',
          },
        },
      ],
      [
        { from: 'wait', to: 'defer', condition: "wait.status == 'waiting'" },
        { from: 'wait', to: 'evidence', condition: "wait.status == 'success'" },
        { from: 'evidence', to: 'judge', condition: "evidence.status == 'success'" },
        { from: 'evidence', to: 'cancel', condition: "evidence.status != 'success'" },
        { from: 'judge', to: 'submit', condition: "judge.outcome != 'inconclusive' && judge.outcome != ''" },
        { from: 'judge', to: 'cancel', condition: "judge.outcome == 'inconclusive' || judge.outcome == ''" },
      ],
      {
        max_total_time_seconds: 172800,
        max_total_tokens: 120000,
      },
    )
  },
}

export const RESOLUTION_BLUEPRINT_PRESETS: Record<
  ResolutionBlueprintPresetId,
  ResolutionBlueprintPreset
> = {
  human_judge: humanJudgePreset,
  api_fetch: apiFetchPreset,
  llm_judge: llmJudgePreset,
  api_fetch_llm: apiFetchLLMPreset,
  api_fetch_wait: apiFetchWaitPreset,
  participant_evidence_llm: participantEvidenceLLMPreset,
}

export function getResolutionBlueprintPreset(id: ResolutionBlueprintPresetId): ResolutionBlueprintPreset {
  return RESOLUTION_BLUEPRINT_PRESETS[id]
}

export function buildResolutionBlueprintPreset(id: ResolutionBlueprintPresetId): ResolutionBlueprint {
  return getResolutionBlueprintPreset(id).build()
}
