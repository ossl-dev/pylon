import type { z } from 'zod';

export type VersionFormat = 'semantic' | 'numeric' | 'date-monthly' | 'date-daily' | 'calver';
export type TransformDirection = 'request' | 'response';
export type ErrorStrategy = 'reject' | 'fallback' | 'passthrough' | 'log-and-continue';
export type NegotiationStrategy = 'highest-supported' | 'exact' | 'closest';
export type MissingStrategy = 'use-default' | 'reject' | 'use-oldest';
export type InvalidStrategy = 'reject' | 'use-default';

export interface VersionDefinition {
  name: string;
  order: number;
  deprecated?: boolean;
  sunsetDate?: string;
  migrationGuide?: string;
}

export type SchemaMap = Record<string, z.ZodTypeAny>;

export interface TransformPair<I = any, O = any> {
  request?: (input: I) => O | Promise<O>;
  response?: (input: O) => I | Promise<I>;
  onError?: TransformErrorConfig;
}

export interface TransformErrorConfig {
  strategy: ErrorStrategy;
  errorCode?: string;
  fallback?: (input: any) => any;
}

export interface VersionSource {
  type: 'header' | 'path' | 'query' | 'body';
  name?: string;
  pattern?: RegExp;
}

export interface NegotiationConfig {
  strategy: NegotiationStrategy;
  onUnsupported?: 'use-default' | 'reject' | 'use-closest';
}

export interface ResponseHeadersConfig {
  apiVersion?: boolean;
  deprecation?: boolean;
  debug?: 'none' | 'development' | 'always';
}

export interface VersioningConfig {
  sources: VersionSource[];
  onMissing?: MissingStrategy;
  onInvalid?: InvalidStrategy;
  negotiation?: NegotiationConfig;
  headers?: ResponseHeadersConfig;
  rateLimit?: Record<string, { requests: number; window: string }>;
}

export interface EndpointConfig {
  current?: string;
  versioning?: false;
  minVersion?: string;
  onOldVersion?: 'reject' | 'use-closest';
  schemas?: SchemaMap;
  transforms?: Record<string, TransformPair>;
}

export interface ObservabilityConfig {
  metrics?: boolean;
  logs?: boolean;
  traces?: boolean;
  onTransform?: (info: TransformEvent) => void;
  onError?: (error: TransformErrorEvent) => void;
}

export interface TransformEvent {
  source: string;
  target: string;
  direction: TransformDirection;
  durationMs: number;
  endpoint?: string;
}

export interface TransformErrorEvent {
  source: string;
  target: string;
  direction: TransformDirection;
  originalError: Error;
  request?: any;
  endpoint?: string;
}

export interface DebugConfig {
  enabled: boolean;
  header?: string;
}

export interface StripePreset {
  preset: 'stripe';
}

export interface CustomVersionsConfig {
  format: 'custom';
  parse: (v: string) => { order: number; label: string };
  formatVersion: (v: any) => string;
  compare?: (a: string, b: string) => number;
}

export type VersionsConfig =
  | {
      format: VersionFormat;
      prefix?: string;
      dateFormat?: string;
      calverFormat?: string;
      aliases?: Record<string, string>;
    }
  | VersionDefinition[]
  | StripePreset
  | CustomVersionsConfig;

export interface PylonConfig {
  current: string;
  defaultVersion?: string;
  versions?: VersionsConfig;
  schemas: SchemaMap;
  transforms: Record<string, TransformPair>;
  versioning?: VersioningConfig;
  endpoints?: Record<string, EndpointConfig>;
  observability?: ObservabilityConfig;
  debug?: DebugConfig;
  onTransformError?: (error: TransformErrorEvent) => void;
}

export interface VersionResult {
  version: string;
  source: 'header' | 'path' | 'query' | 'body' | 'default';
  headerName?: string;
}

export interface TransformResult {
  status: 'success' | 'error' | 'fallback' | 'passthrough';
  data?: any;
  error?: { code: string; message: string; details?: Record<string, any> };
}

export interface ProcessRequestOptions {
  endpoint?: string;
  version?: string;
}

export interface ProcessRequestResult {
  status: number;
  body?: any;
  headers: Record<string, string>;
  debug?: DebugInfo;
}

export interface DebugInfo {
  clientVersion: string;
  currentVersion: string;
  transformsApplied: string[];
  originalRequest?: any;
  transformedRequest?: any;
  originalResponse?: any;
  transformedResponse?: any;
  durationMs: number;
}

export interface RollbackConfig {
  reason: string;
  fallback: string;
  notifiedBy?: string;
  mode?: 'downgrade' | 'reject' | 'shadow';
}

export interface RollbackStatus {
  unpublishedVersion: string;
  fallbackVersion: string;
  timestamp: Date;
  reason: string;
  mode: 'downgrade' | 'reject' | 'shadow';
  active: boolean;
}
