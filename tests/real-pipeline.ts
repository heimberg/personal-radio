// Test helper: the real SegmentPipeline with fake providers. Its own checks (sources, limits, script shape)
// then run as in production, so a test catches what the simple pipeline stand-ins let through.
import { SegmentPipeline } from '../server/segment-pipeline.ts';
import type { Script, Source } from '../src/domain/program.ts';

export function realPipeline(write?: (sources: Source[]) => Partial<Script>) {
  const seen: Source[][] = [];
  const pipeline = new SegmentPipeline(
    { generate: async (_profile, sources) => {
      seen.push(sources);
      return { title: 'Ein Beitrag', text: 'Ein gesprochener Text für das Radio.', sourceIds: [sources[0].id], interestTags: [], ...write?.(sources) };
    } },
    { synthesize: async () => new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]) },
    { verify: async () => ({ approved: true, reasons: [] }) },
    { reserve: async () => {} },
  );
  return { pipeline, seen };
}
