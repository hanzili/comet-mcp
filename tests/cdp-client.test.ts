import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chrome-remote-interface before import
vi.mock('chrome-remote-interface', () => ({
  default: vi.fn(),
}));

// We need to import after mocking
import { CometCDPClient } from '../src/cdp-client.js';

// Helper to create mock targets
function mockTargets(urls: string[]) {
  return urls.map((url, i) => ({
    id: `target-${i}`,
    type: 'page',
    title: `Page ${i}`,
    url,
  }));
}

describe('CometCDPClient', () => {
  let client: CometCDPClient;

  beforeEach(() => {
    client = new CometCDPClient();
    vi.clearAllMocks();
  });

  describe('listTargetsWithRetry', () => {
    it('retries on transient failure and succeeds', async () => {
      const targets = mockTargets(['https://www.perplexity.ai/']);

      // Mock listTargets to fail twice, succeed third time
      const mockListTargets = vi.fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(targets);

      // Override listTargets on the instance
      client.listTargets = mockListTargets;

      const result = await client.listTargetsWithRetry(3, 100);
      expect(result).toHaveLength(1);
      expect(result[0].url).toContain('perplexity.ai');
      expect(mockListTargets).toHaveBeenCalledTimes(3);
    });

    it('throws after all retries exhausted', async () => {
      client.listTargets = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(client.listTargetsWithRetry(3, 100)).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('isAgentBrowsing', () => {
    it('returns true when non-Perplexity tabs exist', async () => {
      client.listTargetsWithRetry = vi.fn().mockResolvedValue(
        mockTargets([
          'https://www.perplexity.ai/',
          'https://www.linkedin.com/in/someone/',
        ])
      );

      const result = await client.isAgentBrowsing();
      expect(result.browsing).toBe(true);
      expect(result.url).toContain('linkedin.com');
    });

    it('returns false when only Perplexity tabs exist', async () => {
      client.listTargetsWithRetry = vi.fn().mockResolvedValue(
        mockTargets([
          'https://www.perplexity.ai/',
          'https://www.perplexity.ai/search',
        ])
      );

      const result = await client.isAgentBrowsing();
      expect(result.browsing).toBe(false);
      expect(result.url).toBeNull();
    });

    it('filters out chrome-extension and about:blank tabs', async () => {
      client.listTargetsWithRetry = vi.fn().mockResolvedValue(
        mockTargets([
          'https://www.perplexity.ai/',
          'chrome-extension://abc/overlay.html',
          'about:blank',
          'chrome://newtab',
        ])
      );

      const result = await client.isAgentBrowsing();
      expect(result.browsing).toBe(false);
    });
  });

  describe('reconnect', () => {
    it('finds Perplexity tab by URL when lastTargetId is stale', async () => {
      // Set a stale target ID
      (client as any).lastTargetId = 'old-stale-id';
      (client as any).state = { connected: false, port: 9222 };

      // Mock getVersion (Comet is running)
      (client as any).getVersion = vi.fn().mockResolvedValue({ Browser: 'Chrome/145' });

      // Mock listTargetsWithRetry: new IDs, stale ID not present
      client.listTargetsWithRetry = vi.fn().mockResolvedValue(
        mockTargets([
          'https://www.perplexity.ai/',
          'https://www.linkedin.com/in/someone/',
        ])
      );

      // Mock connect
      const mockConnect = vi.fn().mockResolvedValue('Connected');
      client.connect = mockConnect;

      await client.reconnect();

      // Should connect to the perplexity.ai tab (target-0)
      expect(mockConnect).toHaveBeenCalledWith('target-0');
    });

    it('falls back to lastTargetId when no Perplexity tab exists', async () => {
      (client as any).lastTargetId = 'target-1';
      (client as any).state = { connected: false, port: 9222 };

      (client as any).getVersion = vi.fn().mockResolvedValue({ Browser: 'Chrome/145' });

      // No perplexity.ai tab, but lastTargetId is present
      client.listTargetsWithRetry = vi.fn().mockResolvedValue([
        { id: 'target-1', type: 'page', title: 'Other', url: 'https://example.com' },
      ]);

      const mockConnect = vi.fn().mockResolvedValue('Connected');
      client.connect = mockConnect;

      await client.reconnect();

      expect(mockConnect).toHaveBeenCalledWith('target-1');
    });
  });
});
