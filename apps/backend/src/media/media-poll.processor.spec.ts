import type { Job } from 'bullmq';
import type { MediaService } from './media.service';
import { MediaPollProcessor } from './media-poll.processor';

describe('MediaPollProcessor', () => {
  it('把对账交给 MediaService.reconcile（缺省第 1 轮）', async () => {
    const reconcile = jest.fn();
    // cast-at-injection：只用到 reconcile
    const processor = new MediaPollProcessor({
      reconcile,
    } as unknown as MediaService);

    await processor.process({
      data: { versionId: 'v1', attempt: 4 },
    } as Job<{ versionId: string; attempt?: number }>);
    await processor.process({
      data: { versionId: 'v2' },
    } as Job<{ versionId: string; attempt?: number }>);

    expect(reconcile.mock.calls).toEqual([
      ['v1', 4],
      ['v2', 1],
    ]);
  });
});
