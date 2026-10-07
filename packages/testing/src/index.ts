/**
 * @ossl/pylon-testing - Testing utilities for Pylon API versioning.
 *
 * Features:
 * - timeTravel: run tests against every historical version automatically
 * - snapshotVersion: snapshot testing per version
 * - testTransform: unit test a single transform
 * - assertContract: verify transform properties (no data loss, reversibility)
 */

export { assertContract, type ContractAssertion } from './assert-contract.js';
export { type SnapshotOptions, type SnapshotResult, snapshotVersion } from './snapshot.js';
export { testTransform } from './test-transform.js';
export type {
  TimeTravelOptions,
  VersionedRequest,
  VersionedRequestOptions,
  VersionedResponse,
} from './time-travel.js';
export { timeTravel } from './time-travel.js';
