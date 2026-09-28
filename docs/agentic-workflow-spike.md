# Agentic production workflow spike

## Recommendation

Keep agent roles and production policy in a small application-owned registry, and use Cloudflare Workflows as the durable execution adapter for production jobs. Do not make agents call one another directly. A director creates a bounded, inspectable plan; the runtime validates it and schedules registered agents by declared artifact dependencies. This leaves room to add a geologist, biologist, lyric analyst, fact checker, or format editor without changing the execution engine.

For the current Cloudflare Worker, Workflows are the shortest path to durable retries, checkpoints, and resuming a long production after an interruption. The code in `server/agentic/runtime.ts` deliberately depends on a tiny `step.do`-shaped interface rather than a framework package. The unit-test runner proves this adapter boundary and cached-step behavior, but this spike has **not** yet registered a Cloudflare Workflow binding or routed production through it.

## What is in this spike

- A code allowlist of agents, each with a stable ID, version, capabilities, allowed tool names, input parser, output parser, and implementation.
- A JSON-only plan format with task dependencies and explicit artifact references.
- Plan validation for unknown agents, undeclared tools, invalid/cyclic graphs, task limits, and malformed artifact references.
- Bounded parallel batches and durable, versioned task checkpoints through a `DurableStepRunner` interface.
- An artifact byte limit so agent results do not grow without bound.
- Tests for parallel research followed by a song editor, cached resume, denied capabilities/tools, and graph cycles.

## Production shape

The director is a planner, not an unrestricted autonomous agent. It receives the block request and the enabled agent catalog, and returns a structured plan. A deterministic validator rejects anything outside configured policy. Agents get only the tools and credentials granted by the server adapter; a prompt or plan cannot grant itself access. Outputs are schema-checked and cited research is retained as artifacts for later editorial review.

The Android app starts production and shows its progress through the Worker API. Viewing runs in detail or editing the agent catalogue belongs in the web cockpit, following the [division of work](architecture.md#division-of-work-app-and-web-cockpit).

| Role | Typical responsibility | Inputs / outputs |
|---|---|---|
| Director / producer | Plan the hour, select appropriate specialists, order the work, detect gaps, request revisions | Brief and station rules → bounded task graph and final rundown |
| Music researcher | Verify artist, recording, release, context, and reliable sources for each selected song | Track metadata → sourced song facts |
| Lyric analyst | Analyze themes and selected lyric excerpts where use is permitted; avoid reproducing lyrics | Track identity / permitted excerpt → short thematic notes |
| Specialist researcher | Supply domain knowledge for a topic block (geology, biology, history, etc.) | Topic question → sourced claims and uncertainty |
| Fact checker | Check each factual statement against evidence; flag weak or conflicting sources | Draft and source artifacts → claim review |
| Segment editor | Turn approved evidence into spoken copy in the station's tone and duration | Evidence and format → script with claim/source mapping |
| Continuity editor | Check transitions, repetition, pacing, song order, and timing across the whole block | Draft rundown → issues and targeted revisions |
| Script approver | Apply existing safety, citation, length, and TTS validation gates | Candidate script → approved or rejected script |

Keep specialist roles as data and code registrations rather than separate workflow classes. The same specialist interface can serve a music hour or a topic show; a workflow policy decides which roles and tools are available for a particular production.

## Execution outline

1. The existing app asks the Worker to produce a block. Existing production remains the active path.
2. The workflow creates a run record with owner, requested format, plan version, and policy snapshot.
3. The director proposes a plan from the enabled catalog. The server validates task count, tools, dependencies, and output contracts.
4. Independent research tasks run concurrently. The editor starts only after its declared evidence artifacts are ready.
5. The fact checker and continuity editor review the full draft. The director may request bounded, targeted revisions.
6. Existing script approval and TTS gates remain authoritative. On approval, the workflow writes the same production result format the app already consumes.
7. The app can show production status, stage, partial artifacts, and actionable errors; a retry resumes completed durable steps.

Retries need stable step names and immutable inputs for a run. If an agent's prompt or implementation changes, increment its version so a new run/checkpoint identity is explicit. Keep large audio and source documents in object storage and pass references between steps; Workflow payloads should hold compact JSON artifacts only.

## Framework comparison

| Option | Fit here | Trade-off |
|---|---|---|
| Cloudflare Workflows + small registry (recommended) | Good fit for queued production jobs on the existing Worker; durable steps and retries without changing the model provider | Workflow binding, run storage/UI and an adapter still need implementation; app-specific contracts remain our responsibility |
| Mastra | Stronger built-in agent, tool, workflow, and development/observability surface; worth a focused prototype if agent authoring becomes a major product area | Adds another framework and runtime abstraction; Cloudflare deployment and durable persistence need deliberate configuration and validation |
| LangGraph.js | Useful if graph state, branching, human review, and complex loops become the dominant requirements | More orchestration surface than the current bounded production pipeline needs |
| Cloudflare Agents SDK | Useful for persistent, interactive agents with per-user/session state | Its stateful Durable Object model is not the default fit for an ephemeral queued show-production run |

The spike does not establish that Workflows are cheaper or more capable in every case. Before production rollout, compare actual execution duration, step count, provider latency/cost, failure recovery, and deployment complexity using one end-to-end music-hour run. Avoid using multiple orchestration frameworks together initially.

## Rollout sequence

1. Add the Workflow binding and a thin `WorkflowEntrypoint` adapter; keep it behind an explicit feature flag and leave the existing queue producer untouched by default.
2. Register only music-hour roles first: director, per-song researcher, lyric analyst, fact checker, segment editor, continuity editor.
3. Run shadow productions and compare artifacts, script approval outcomes, time, and provider cost with the existing Gemini path.
4. Add app-side progress and retry controls only after workflow status and ownership are reliable.
5. Expand the same registry with topic specialists after the first format meets quality and cost targets.

## Framework references

- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/): durable execution, step retries, and checkpointing.
- [Mastra workflows](https://mastra.ai/docs/workflows/overview): typed workflow orchestration and branching.
- [Mastra Cloudflare deployment](https://mastra.ai/docs/deployment/cloudflare-workers): deployment considerations for Workers.
- [LangGraph.js](https://langchain-ai.github.io/langgraphjs/): graph-based agent orchestration and state.
- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/): stateful agents on Durable Objects.
