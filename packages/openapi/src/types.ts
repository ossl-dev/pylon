export interface OpenAPIGenerateOptions {
  /** Which versions to include. Default: all. */
  versions?: string[];
  /** Output format */
  format?: 'json' | 'yaml';
  /** API info */
  info?: {
    title?: string;
    description?: string;
    version?: string;
    termsOfService?: string;
    contact?: { name?: string; url?: string; email?: string };
    license?: { name: string; url?: string };
  };
  /** Server URLs */
  servers?: Array<{ url: string; description?: string }>;
  /** Auth schemes */
  securitySchemes?: Record<string, SecurityScheme>;
}

export interface SecurityScheme {
  type: 'http' | 'apiKey' | 'oauth2' | 'openIdConnect';
  scheme?: string;
  bearerFormat?: string;
  in?: 'header' | 'query' | 'cookie';
  name?: string;
  description?: string;
}

export interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    description?: string;
    version: string;
    termsOfService?: string;
    contact?: { name?: string; url?: string; email?: string };
    license?: { name: string; url?: string };
  };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, Record<string, PathItem>>;
  components?: {
    // biome-ignore lint/suspicious/noExplicitAny: OpenAPI accepts arbitrary JSON Schema extensions
    schemas?: Record<string, any>;
    // biome-ignore lint/suspicious/noExplicitAny: Security schemes config varies per provider
    securitySchemes?: Record<string, any>;
  };
  security?: Array<Record<string, string[]>>;
}

export interface PathItem {
  'x-pylon-contracts'?: Record<string, { request?: SchemaObject; response?: SchemaObject }>;
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses: Record<string, ResponseObject>;
  deprecated?: boolean;
  security?: Array<Record<string, string[]>>;
}

export interface ParameterObject {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema: SchemaObject;
  deprecated?: boolean;
}

export interface RequestBodyObject {
  required?: boolean;
  description?: string;
  content: Record<string, MediaTypeObject>;
}

export interface ResponseObject {
  description: string;
  content?: Record<string, MediaTypeObject>;
  headers?: Record<string, { schema: SchemaObject; description?: string }>;
}

export interface MediaTypeObject {
  schema: SchemaObject;
  /** @example can be any valid JSON value */
  // biome-ignore lint/suspicious/noExplicitAny: OpenAPI example values are untyped
  example?: any;
}

export interface SchemaObject {
  type?: string | string[];
  const?: unknown;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  required?: string[];
  enum?: unknown[];
  description?: string;
  /** @default can be any valid JSON value */
  // biome-ignore lint/suspicious/noExplicitAny: OpenAPI default values are untyped
  default?: any;
  nullable?: boolean;
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  allOf?: SchemaObject[];
  $ref?: string;
  additionalProperties?: boolean | SchemaObject;
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}
