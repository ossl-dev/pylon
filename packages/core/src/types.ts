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
  unpublished?: boolean;
  retired?: boolean;
  sunsetDate?: string;
  migrationGuide?: string;
  aliases?: string[];
}

export type SchemaMap = Record<string, z.ZodTypeAny>;

export interface TransformPair<I = any, O = any> {
  request?: ((input: I) => O | Promise<O>) | 'identity';
  response?: ((input: O) => I | Promise<I>) | 'identity';
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
}

export interface VersioningConfig {
  sources: VersionSource[];
  onMissing?: MissingStrategy;
  onInvalid?: InvalidStrategy;
  negotiation?: NegotiationConfig;
  headers?: ResponseHeadersConfig;
}

export interface VersionContract {
  request?: z.ZodTypeAny;
  response?: z.ZodTypeAny;
}

export type ContractMap = Record<string, VersionContract>;
export type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface EndpointConfig {
  method?: HTTPMethod;
  path?: string;
  status?: number;
  contracts?: ContractMap;
  current?: string;
  versioning?: false;
  minVersion?: string;
  onOldVersion?: 'reject' | 'use-closest';
  schemas?: SchemaMap;
  transforms?: Record<string, TransformPair>;
}

export interface ObservabilityConfig {
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
  start?: string;
  end?: string;
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
      start?: string;
      end?: string;
    }
  | VersionDefinition[]
  | string[]
  | StripePreset
  | CustomVersionsConfig;

export interface PylonConfig {
  current: string;
  defaultVersion?: string;
  versions?: VersionsConfig;
  schemas: SchemaMap;
  transforms: Record<string, TransformPair>;
  contracts?: ContractMap;
  versioning?: VersioningConfig;
  endpoints?: Record<string, EndpointConfig>;
  observability?: ObservabilityConfig;
  debug?: DebugConfig;
  onTransformError?: (error: TransformErrorEvent) => void;
}

export type PylonOptions = Omit<PylonConfig, 'schemas' | 'transforms'> &
  Partial<Pick<PylonConfig, 'schemas' | 'transforms'>>;

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
