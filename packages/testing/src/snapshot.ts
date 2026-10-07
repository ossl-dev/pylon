import type { Pylon } from '@ossl/pylon-core';
import type { TimeTravelOptions, VersionedRequest } from './time-travel.js';
import { timeTravel } from './time-travel.js';

export interface SnapshotResult<T = unknown> {
  version: string;
  data: T;
}
export type SnapshotOptions = TimeTravelOptions;

/** Snapshot wire responses; the version argument selects the appropriate request fixture. */
export async function snapshotVersion<T>(
  pylon: Pylon,
  fetcher: (request: VersionedRequest, version: string) => Promise<T>,
  options?: SnapshotOptions,
): Promise<SnapshotResult<T>[]> {
  const results: SnapshotResult<T>[] = [];
  await timeTravel(
    pylon,
    async (version, request) => {
      results.push({ version, data: await fetcher(request, version) });
    },
    options,
  );
  return results;
}
