/** Framework-neutral, bounded agent workflow runtime. A Cloudflare WorkflowStep can execute each node durably. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface AgentContext {
  runId: string;
  ownerId: string;
  agentId: string;
  agentVersion: number;
  grantedTools: readonly string[];
}

/** Agents validate their own typed contracts; the runtime only transports JSON-safe artifacts. */
export interface AgentDefinition<Input = unknown, Output = unknown> {
  id: string;
  version: number;
  description: string;
  capabilities: readonly string[];
  tools: readonly string[];
  parseInput(value: unknown): Input;
  run(input: Input, context: AgentContext): Promise<Output>;
  parseOutput(value: unknown): JsonValue;
}

type AnyAgent = AgentDefinition<any, any>;

/** Code-registered agents are the allowlisted capabilities a director may assign in a plan. */
export class AgentRegistry {
  private readonly agents = new Map<string, AnyAgent>();

  register(agent: AnyAgent): this {
    if (!/^[a-z][a-z0-9.-]{1,79}$/.test(agent.id)) throw new Error(`Invalid agent id: ${agent.id}`);
    if (!Number.isSafeInteger(agent.version) || agent.version < 1) throw new Error(`Invalid agent version: ${agent.id}`);
    if (!agent.description.trim()) throw new Error(`Missing agent description: ${agent.id}`);
    if (this.agents.has(agent.id)) throw new Error(`Agent already registered: ${agent.id}`);
    this.agents.set(agent.id, agent);
    return this;
  }

  get(id: string): AnyAgent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    return agent;
  }

  catalog(allowed: readonly string[]): Array<Pick<AnyAgent, 'id' | 'version' | 'description' | 'capabilities' | 'tools'>> {
    return [...new Set(allowed)].map(id => {
      const { id: agentId, version, description, capabilities, tools } = this.get(id);
      return { id: agentId, version, description, capabilities: [...capabilities], tools: [...tools] };
    });
  }
}

export interface PlannedTask {
  id: string;
  agentId: string;
  dependsOn: string[];
  input: JsonValue;
}

export interface AgentPlan {
  workflowId: string;
  version: number;
  tasks: PlannedTask[];
}

export interface WorkflowPolicy {
  allowedAgents: readonly string[];
  allowedTools: readonly string[];
  maxTasks: number;
  maxConcurrency: number;
  maxArtifactBytes: number;
}

export interface DurableStepRunner {
  do<T>(name: string, config: { retries: { limit: number; delay: string; backoff: 'exponential' } }, callback: () => Promise<T>): Promise<T>;
}

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const ARTIFACT_MARKER = '$artifact';

function artifactReferences(value: JsonValue, out: Array<{ taskId: string; path: string[] }> = []): Array<{ taskId: string; path: string[] }> {
  if (Array.isArray(value)) { for (const item of value) artifactReferences(item, out); return out; }
  if (!value || typeof value !== 'object') return out;
  const record = value as Record<string, JsonValue>;
  if (typeof record[ARTIFACT_MARKER] === 'string') {
    if (Object.keys(record).some(key => ![ARTIFACT_MARKER, 'path'].includes(key)) ||
        (record.path !== undefined && (!Array.isArray(record.path) || record.path.some(part => typeof part !== 'string')))) {
      throw new Error('Malformed artifact reference');
    }
    out.push({ taskId: record[ARTIFACT_MARKER] as string, path: (record.path as string[] | undefined) ?? [] });
    return out;
  }
  for (const item of Object.values(record)) artifactReferences(item, out);
  return out;
}

function resolveInput(value: JsonValue, artifacts: Map<string, JsonValue>): JsonValue {
  if (Array.isArray(value)) return value.map(item => resolveInput(item, artifacts));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, JsonValue>;
  if (typeof record[ARTIFACT_MARKER] === 'string') {
    let resolved = artifacts.get(record[ARTIFACT_MARKER] as string);
    if (resolved === undefined) throw new Error(`Missing artifact: ${record[ARTIFACT_MARKER]}`);
    for (const part of (record.path as string[] | undefined) ?? []) {
      if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved) || !(part in resolved)) throw new Error(`Artifact path not found: ${part}`);
      resolved = (resolved as Record<string, JsonValue>)[part];
    }
    return resolved;
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, resolveInput(item, artifacts)]));
}

function validatePlan(plan: AgentPlan, policy: WorkflowPolicy, registry: AgentRegistry) {
  if (!IDENTIFIER.test(plan.workflowId) || !Number.isSafeInteger(plan.version) || plan.version < 1) throw new Error('Invalid workflow identity');
  if (!Number.isSafeInteger(policy.maxTasks) || policy.maxTasks < 1 || plan.tasks.length < 1 || plan.tasks.length > policy.maxTasks) throw new Error('Workflow task limit exceeded');
  if (!Number.isSafeInteger(policy.maxConcurrency) || policy.maxConcurrency < 1) throw new Error('Invalid workflow concurrency');
  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if (!IDENTIFIER.test(task.id) || ids.has(task.id)) throw new Error(`Invalid or duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (!policy.allowedAgents.includes(task.agentId)) throw new Error(`Agent is not allowed in workflow: ${task.agentId}`);
    const agent = registry.get(task.agentId);
    const denied = agent.tools.find(tool => !policy.allowedTools.includes(tool));
    if (denied) throw new Error(`Tool is not allowed in workflow: ${denied}`);
    if (!Array.isArray(task.dependsOn) || new Set(task.dependsOn).size !== task.dependsOn.length) throw new Error(`Invalid dependencies: ${task.id}`);
    for (const ref of artifactReferences(task.input)) {
      if (!task.dependsOn.includes(ref.taskId)) throw new Error(`Task ${task.id} references undeclared dependency ${ref.taskId}`);
    }
  }
  const byId = new Map(plan.tasks.map(task => [task.id, task]));
  for (const task of plan.tasks) for (const dependency of task.dependsOn) {
    if (!byId.has(dependency) || dependency === task.id) throw new Error(`Unknown or self dependency: ${task.id} -> ${dependency}`);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`Workflow cycle detected at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
}

/** Runs only registered, policy-approved agents. Each node result is a durable, versioned checkpoint. */
export async function runAgentPlan(input: {
  plan: AgentPlan;
  runId: string;
  ownerId: string;
  registry: AgentRegistry;
  policy: WorkflowPolicy;
  steps: DurableStepRunner;
}): Promise<Record<string, JsonValue>> {
  const { plan, runId, ownerId, registry, policy, steps } = input;
  if (!IDENTIFIER.test(runId) || !IDENTIFIER.test(ownerId)) throw new Error('Invalid workflow run or owner id');
  validatePlan(plan, policy, registry);
  const artifacts = new Map<string, JsonValue>();
  const remaining = new Map(plan.tasks.map(task => [task.id, task]));
  const completed = new Set<string>();

  while (remaining.size) {
    const ready = [...remaining.values()].filter(task => task.dependsOn.every(id => completed.has(id)));
    if (!ready.length) throw new Error('Workflow has unresolved dependencies');
    for (let offset = 0; offset < ready.length; offset += policy.maxConcurrency) {
      const batch = ready.slice(offset, offset + policy.maxConcurrency);
      const results = await Promise.all(batch.map(async task => {
        const agent = registry.get(task.agentId);
        const taskInput = agent.parseInput(resolveInput(task.input, artifacts));
        const stepName = `${plan.workflowId}:v${plan.version}:${runId}:${task.id}:agent-v${agent.version}`;
        if (stepName.length > 256) throw new Error('Workflow step name exceeds Cloudflare limit');
        const result = await steps.do(stepName, { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' } }, async () => {
          const raw = await agent.run(taskInput, { runId, ownerId, agentId: agent.id, agentVersion: agent.version, grantedTools: [...agent.tools] });
          const output = agent.parseOutput(raw);
          if (new TextEncoder().encode(JSON.stringify(output)).byteLength > policy.maxArtifactBytes) throw new Error(`Agent artifact exceeds size limit: ${task.id}`);
          return output;
        });
        return [task, result] as const;
      }));
      for (const [task, result] of results) {
        artifacts.set(task.id, result);
        completed.add(task.id);
        remaining.delete(task.id);
      }
    }
  }
  return Object.fromEntries(artifacts);
}
