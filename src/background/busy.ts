// One lock per platform (design 3.0): while a switch, an add or a recovery runs on a platform,
// anything else that would read or change that platform's account gets `busy`.
import { err, type Result } from '../lib/result';
import type { Platform } from '../lib/store';

/**
 * Runs `job` while holding `platform`. The check and the add happen before the first await, so two
 * messages that arrive together can't both get the lock.
 */
export async function holdPlatform<T>(
  busy: Set<Platform>,
  platform: Platform,
  job: () => Promise<T>,
): Promise<T | Result<never, 'busy'>> {
  if (busy.has(platform)) return err('busy');
  busy.add(platform);
  try {
    return await job();
  } finally {
    busy.delete(platform);
  }
}
