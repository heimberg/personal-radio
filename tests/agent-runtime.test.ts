import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry, runAgentPlan, type AgentDefinition, type AgentPlan, type DurableStepRunner, type JsonValue } from '../server/agentic/runtime.ts';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
  return value as Record<string, unknown>;
}

class CachedSteps implements DurableStepRunner {
  readonly calls = new Map<string, number>();
  private readonly cache = new Map<string, JsonValue>();
  async do<T>(name: string, _config: { retries: { limit: number; delay: string; backoff: 'exponential' } }, callback: () => Promise<T>): Promise<T> {
    if (this.cache.has(name)) return this.cache.get(name) as T;
    this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
    const result = await callback();
    this.cache.set(name, result as JsonValue);
    return result;
  }
}

function agent<Input, Output>(definition: Pick<AgentDefinition<Input, Output>, 'id' | 'description' | 'capabilities' | 'tools' | 'parseInput' | 'run' | 'parseOutput'> & { version?: number }): AgentDefinition<Input, Output> {
  return { ...definition, version: definition.version ?? 1 };
}

test('agent registry executes a dependency graph and resumes cached steps', async () => {
  let researchRuns = 0, lyricRuns = 0, writingRuns = 0;
  const registry = new AgentRegistry()
    .register(agent({
      id: 'research.song', version: 1, description: 'Research song history', capabilities: ['research.song'], tools: ['google-search'],
      parseInput: value => object(value),
      run: async input => { researchRuns++; return { fact: `Recorded in ${String(input.title)} era` }; },
      parseOutput: value => ({ ...object(value) } as JsonValue),
    }))
    .register(agent({
      id: 'research.lyrics', version: 1, description: 'Analyze lyric themes', capabilities: ['analyze.lyrics'], tools: ['lyric-source'],
      parseInput: value => object(value),
      run: async () => { lyricRuns++; return { themes: ['loss', 'return'] }; },
      parseOutput: value => ({ ...object(value) } as JsonValue),
    }))
    .register(agent({
      id: 'editor.song', version: 1, description: 'Write a sourced song introduction', capabilities: ['write.moderation'], tools: [],
      parseInput: value => object(value),
      run: async input => { writingRuns++; return { intro: `${String(input.fact)}; themes: ${(input.themes as string[]).join(', ')}` }; },
      parseOutput: value => ({ ...object(value) } as JsonValue),
    }));
  const plan: AgentPlan = {
    workflowId: 'music-hour', version: 1,
    tasks: [
      { id: 'song-history', agentId: 'research.song', dependsOn: [], input: { title: 'Example Song' } },
      { id: 'lyric-themes', agentId: 'research.lyrics', dependsOn: [], input: { title: 'Example Song' } },
      { id: 'song-intro', agentId: 'editor.song', dependsOn: ['song-history', 'lyric-themes'], input: {
        fact: { $artifact: 'song-history', path: ['fact'] }, themes: { $artifact: 'lyric-themes', path: ['themes'] },
      } },
    ],
  };
  const steps = new CachedSteps();
  const args = { plan, runId: 'run-1', ownerId: 'owner-1', registry, steps,
    policy: { allowedAgents: ['research.song', 'research.lyrics', 'editor.song'], allowedTools: ['google-search', 'lyric-source'], maxTasks: 20, maxConcurrency: 2, maxArtifactBytes: 65_536 } };
  const first = await runAgentPlan(args);
  assert.match(String((first['song-intro'] as { intro: string }).intro), /themes: loss, return/);
  await runAgentPlan(args);
  assert.deepEqual([researchRuns, lyricRuns, writingRuns], [1, 1, 1]);
  assert.equal(steps.calls.size, 3);
});

test('agent plans reject unregistered capabilities, hidden tool grants, and invalid graphs', async () => {
  const registry = new AgentRegistry().register(agent({
    id: 'research.geology', version: 1, description: 'Research geology', capabilities: ['research.geology'], tools: ['google-search'],
    parseInput: value => value, run: async () => ({ notes: [] }), parseOutput: value => ({ ...object(value) } as JsonValue),
  }));
  const steps = new CachedSteps();
  const base = { workflowId: 'topic-block', version: 1, tasks: [{ id: 'expert', agentId: 'research.geology', dependsOn: [], input: {} }] };
  const policy = { allowedAgents: ['research.geology'], allowedTools: [], maxTasks: 10, maxConcurrency: 2, maxArtifactBytes: 65_536 };
  await assert.rejects(runAgentPlan({ plan: base, runId: 'run-2', ownerId: 'owner-1', registry, policy, steps }), /Tool is not allowed/);
  await assert.rejects(runAgentPlan({ plan: { ...base, tasks: [{ ...base.tasks[0], agentId: 'research.biologist' }] }, runId: 'run-2', ownerId: 'owner-1', registry,
    policy: { ...policy, allowedAgents: ['research.biologist'], allowedTools: ['google-search'] }, steps }), /Unknown agent/);
  await assert.rejects(runAgentPlan({ plan: { ...base, tasks: [
    { id: 'a', agentId: 'research.geology', dependsOn: ['b'], input: {} },
    { id: 'b', agentId: 'research.geology', dependsOn: ['a'], input: {} },
  ] }, runId: 'run-2', ownerId: 'owner-1', registry, policy: { ...policy, allowedTools: ['google-search'] }, steps }), /cycle/);
});
