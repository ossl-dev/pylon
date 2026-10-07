import type { Pylon } from '@ossl/pylon-core';
import { RegistrationStore } from './registration-store.js';
import type { WebhookEvent, WebhookRegistration, WebhookResult } from './types.js';

/**
 * Generate a unique identifier.
 * Uses timestamp combined with random hex for uniqueness
 * without depending on Node.js crypto types.
 */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/**
 * PylonWebhook — Webhook versioning using Pylon's transform engine.
 *
 * Automatically transforms webhook payloads to the version expected
 * by each registered endpoint. When a webhook is sent, the payload
 * is run through Pylon's transform pipeline so that customers on
 * different API versions each receive a payload shaped for their version.
 *
 * @example
 * ```ts
 * import { Pylon } from '@ossl/pylon-core';
 * import { PylonWebhook } from '@ossl/pylon-webhooks';
 *
 * const pylon = new Pylon({ ... });
 * const webhooks = new PylonWebhook(pylon);
 *
 * // Register a webhook endpoint for a v2 customer
 * webhooks.register({
 *   url: 'https://customer.com/webhooks',
 *   events: ['user.created'],
 *   version: 'v2',
 * });
 *
 * // Send a webhook — payload is auto-transformed to v2
 * await webhooks.send({
 *   event: 'user.created',
 *   payload: { fullName: 'John', email: 'john@test.com' },
 * });
 * ```
 */
export interface WebhookOptions {
  /** Maximum retained deliveries for replay. Defaults to 1000; zero disables history. */
  historyLimit?: number;
}

export class PylonWebhook {
  private historyLimit: number;
  private pylon: Pylon;
  private store: RegistrationStore;
  private history: Map<string, { event: WebhookEvent; sourcePayload: Record<string, unknown> }>;

  /**
   * Maps registration IDs to active migration state.
   * During the grace period, webhooks are sent to both the old and new versions.
   */
  private migrations: Map<
    string,
    { oldVersion: string; migrationTime: number; gracePeriodMs: number }
  >;

  /**
   * @param pylon - A configured Pylon instance used for payload transformation
   * @param store - Optional custom registration store; a default in-memory store is created if omitted
   */
  constructor(pylon: Pylon, store?: RegistrationStore, options: WebhookOptions = {}) {
    this.historyLimit = options.historyLimit ?? 1000;
    if (!Number.isSafeInteger(this.historyLimit) || this.historyLimit < 0)
      throw new Error('historyLimit must be a non-negative safe integer');
    this.pylon = pylon;
    this.store = store ?? new RegistrationStore();
    this.history = new Map();
    this.migrations = new Map();
  }

  /**
   * Register a webhook endpoint.
   *
   * Generates a unique registration ID and stores the endpoint configuration.
   *
   * @param registration - The webhook endpoint configuration
   * @returns The generated registration ID string
   *
   * @example
   * ```ts
   * const id = webhooks.register({
   *   url: 'https://example.com/hooks',
   *   events: ['order.placed'],
   *   version: 'v1',
   * });
   * ```
   */
  register(registration: WebhookRegistration): string {
    const id = generateId();
    this.store.register(id, { ...registration });
    return id;
  }

  /**
   * Unregister a webhook endpoint.
   *
   * @param id - The registration ID returned from {@link register}
   * @returns `true` if the registration existed and was removed, `false` otherwise
   */
  unregister(id: string): boolean {
    const removed = this.store.unregister(id);
    this.migrations.delete(id);
    return removed;
  }

  /**
   * Send a webhook event to all registered endpoints for that event.
   *
   * For each matching registration, the payload is transformed from the
   * current API version to the version expected by the registration,
   * then delivered via an HTTP POST request.
   *
   * If a registration has an active migration with a grace period that has
   * not yet expired, the webhook is delivered to both the old and new versions.
   *
   * @param options - The event name and payload
   * @returns Array of delivery results, one per registration (or per version during migrations)
   *
   * @example
   * ```ts
   * const results = await webhooks.send({
   *   event: 'user.created',
   *   payload: { fullName: 'Jane', email: 'jane@test.com' },
   * });
   * console.log(`Delivered to ${results.length} endpoints`);
   * ```
   */
  async send(options: { event: string; payload: Record<string, any> }): Promise<WebhookResult[]> {
    const registrations = this.store.findByEvent(options.event);
    const results: WebhookResult[] = [];

    for (const { id, registration } of registrations) {
      // Determine which versions to deliver to based on active migrations
      const migration = this.migrations.get(id);
      let versionsToSend: string[];

      if (migration && Date.now() - migration.migrationTime < migration.gracePeriodMs) {
        // Grace period still active — deliver to both old and new versions
        versionsToSend = [migration.oldVersion, registration.version];
      } else {
        // No grace period — deliver only to the registered version
        if (migration) {
          // Grace period has expired; clean up the migration entry
          this.migrations.delete(id);
        }
        versionsToSend = [registration.version];
      }

      for (const version of versionsToSend) {
        const idempotencyKey = generateId();
        const result = await this.sendToRegistration(
          registration,
          id,
          options.event,
          options.payload,
          version,
          idempotencyKey,
        );
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Replay a historical webhook event with a different target version.
   *
   * Finds the original event in the history log, then resends it to all
   * currently registered endpoints for that event, transforming the payload
   * to the specified target version. Useful for debugging version migrations
   * or resending failed deliveries.
   *
   * @param eventId - The ID of the historical event to replay
   * @param targetVersion - The API version to transform the payload into for the replay
   * @returns Array of delivery results
   *
   * @example
   * ```ts
   * // Replay a past event as if it were v3
   * const results = await webhooks.replay(eventId, 'v3');
   * ```
   */
  async replay(eventId: string, targetVersion: string): Promise<WebhookResult[]> {
    const record = this.history.get(eventId);
    if (!record) {
      throw new Error(`Webhook event not found: ${eventId}`);
    }

    const event = record.event;
    // Find current registrations for this event
    const registrations = this.store.findByEvent(event.event);
    const results: WebhookResult[] = [];

    for (const { id, registration } of registrations) {
      const idempotencyKey = generateId();
      const result = await this.sendToRegistration(
        registration,
        id,
        event.event,
        record.sourcePayload,
        targetVersion,
        idempotencyKey,
      );
      results.push(result);
    }

    return results;
  }

  /**
   * Retrieve webhook event history.
   *
   * @param eventId - Optional specific event ID to look up. If omitted, all events are returned.
   * @returns Array of historical webhook events
   */
  getHistory(eventId?: string): WebhookEvent[] {
    if (eventId) {
      const record = this.history.get(eventId);
      return record ? [structuredClone(record.event)] : [];
    }
    return Array.from(this.history.values(), (record) => structuredClone(record.event));
  }

  /**
   * Migrate a webhook registration to a new API version.
   *
   * Updates the registration's version immediately. If a `gracePeriodMs`
   * is provided, webhooks will be delivered to both the old and new
   * versions during the grace window, giving the consumer time to
   * update their integration. After the grace period expires, deliveries
   * switch exclusively to the new version.
   *
   * @param id - The registration ID to migrate
   * @param newVersion - The target API version for the migration
   * @param gracePeriodMs - Optional grace period in milliseconds for dual delivery
   *
   * @example
   * ```ts
   * // Immediate migration
   * webhooks.migrateRegistration('reg-123', 'v3');
   *
   * // Migration with 7-day grace period
   * webhooks.migrateRegistration('reg-456', 'v3', 7 * 24 * 60 * 60 * 1000);
   * ```
   */
  migrateRegistration(id: string, newVersion: string, gracePeriodMs?: number): void {
    const registration = this.store.get(id);
    if (!registration) {
      throw new Error(`Webhook registration not found: ${id}`);
    }

    const oldVersion = registration.version;
    registration.version = newVersion;

    if (gracePeriodMs && gracePeriodMs > 0) {
      this.migrations.set(id, {
        oldVersion,
        migrationTime: Date.now(),
        gracePeriodMs,
      });
    }
  }

  /**
   * Transform the payload to the target version and deliver the webhook.
   *
   * Sends an HTTP POST with a JSON body containing the event metadata and
   * the version-transformed payload. Includes idempotency and version
   * information in the request headers so the consumer can validate
   * and deduplicate deliveries.
   *
   * If the transform fails or the HTTP request fails, the result status
   * will be `0` to indicate a non-HTTP error.
   */
  private async sendToRegistration(
    registration: WebhookRegistration,
    registrationId: string,
    event: string,
    payload: Record<string, any>,
    version: string,
    idempotencyKey: string,
  ): Promise<WebhookResult> {
    const startTime = Date.now();

    // Transform payload from current version to the target version
    let transformedPayload: any = payload;

    if (version !== this.pylon.current) {
      try {
        const result = await this.pylon.transform(this.pylon.current, version, 'response', payload);

        if (result.status === 'success' && result.data !== undefined) {
          transformedPayload = result.data;
        } else {
          // Transform returned a non-success status — record the failure
          const timestamp = new Date();
          const durationMs = Date.now() - startTime;

          this.recordEvent(event, version, payload, registrationId, payload);

          return {
            status: 0,
            idempotencyKey,
            timestamp,
            durationMs,
          };
        }
      } catch {
        // Transform threw an unexpected error
        const timestamp = new Date();
        const durationMs = Date.now() - startTime;

        this.recordEvent(event, version, payload, registrationId, payload);

        return {
          status: 0,
          idempotencyKey,
          timestamp,
          durationMs,
        };
      }
    }

    // Build the webhook body
    const body = JSON.stringify({
      id: idempotencyKey,
      event,
      version,
      payload: transformedPayload,
      timestamp: new Date().toISOString(),
    });

    // Deliver the webhook via HTTP POST
    let status: number;

    try {
      const response = await fetch(registration.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-ID': idempotencyKey,
          'X-Webhook-Event': event,
          'X-Webhook-Version': version,
          ...(registration.secret
            ? { 'X-Webhook-Signature': await this.signPayload(body, registration.secret) }
            : {}),
          ...(registration.headers ?? {}),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
    } catch {
      // Network error or timeout
      status = 0;
    }

    const timestamp = new Date();
    const durationMs = Date.now() - startTime;

    // Record in history
    this.recordEvent(event, version, transformedPayload, registrationId, payload);

    return {
      status,
      idempotencyKey,
      timestamp,
      durationMs,
    };
  }

  /**
   * Store a webhook event in the history log.
   */
  private recordEvent(
    event: string,
    version: string,
    payload: unknown,
    registrationId: string,
    sourcePayload: Record<string, unknown>,
  ): void {
    if (this.historyLimit === 0) return;
    const eventRecord: WebhookEvent = {
      id: generateId(),
      event,
      version,
      payload,
      timestamp: new Date(),
      registrationId,
    };
    this.history.set(eventRecord.id, {
      event: structuredClone(eventRecord),
      sourcePayload: structuredClone(sourcePayload),
    });
    if (this.history.size > this.historyLimit) {
      const oldest = this.history.keys().next().value;
      if (oldest !== undefined) this.history.delete(oldest);
    }
  }

  /**
   * Sign a webhook payload with HMAC-SHA256.
   *
   * Uses the Web Crypto API (available in Node 18+, Bun, Deno, and browsers)
   * to produce a hex-encoded HMAC-SHA256 signature. Consumers with the shared
   * secret can verify payload integrity by computing the same HMAC.
   */
  private async signPayload(body: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
