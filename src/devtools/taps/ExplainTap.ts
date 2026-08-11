/**
 * The explain plan (#218) — the last messages one actor handled.
 *
 * Recording is per actor and off by default, so the panel turns it on
 * through `explain.enable` rather than asking for a code change and a
 * restart.  That is the whole point: "what has this actor been doing?"
 * is a question you ask *while* it is misbehaving.
 *
 * Request/response, not a stream: the developer picks one actor and
 * pulls its ring.  Pushing every recorded message for every enabled
 * actor would be a firehose nobody asked for.
 */
import type { ActorSystem } from '../../ActorSystem.js';
import { LocalActorRef } from '../../internal/LocalActorRef.js';
import type { ActorCell } from '../../internal/ActorCell.js';
import type { MessageExplain } from '../../internal/Instrumentation.js';
import { parseSelectionPath } from '../../ActorSelection.js';
import { DEFAULT_EXPLAIN_CAPACITY } from '../../util/Constants.js';
import {
  explainEntriesPayload,
  type ExplainEnableParameters,
  type ExplainEntry,
  type ExplainPathParameters,
  type ExplainStatusResult,
} from '../protocol/index.js';
import type { DevToolsServer } from '../DevToolsServer.js';

/** Refuse anything larger; a ring is a debugging aid, not a log. */
const MAXIMUM_CAPACITY = 10_000;

/**
 * Wires the three `explain.*` methods onto the server.
 *
 * Not a `DevToolsTap`: there is no stream behind it.  The `explain`
 * stream id stays reserved in the protocol for a future live feed.
 */
export class ExplainMethods {
  /** Actors this session switched on, so detach can switch them off. */
  private readonly enabled = new Set<string>();

  constructor(private readonly system: ActorSystem) {}

  /** Register the methods on `server`. */
  install(server: DevToolsServer): void {
    server.registerMethod('explain.enable', (parameters) => this.onEnable(parameters));
    server.registerMethod('explain.disable', (parameters) => this.onDisable(parameters));
    server.registerMethod('explain.fetch', (parameters) => this.onFetch(parameters));
  }

  /**
   * Switch recording off everywhere this session switched it on.
   *
   * Detaching DevTools must leave the system as it was found — an
   * actor left recording forever because a browser tab was closed is a
   * leak the developer never asked for.
   */
  uninstall(): void {
    for (const path of this.enabled) {
      this.cellAt(path)?._disableExplain();
    }
    this.enabled.clear();
  }

  // The handlers are `async` so a validation failure arrives as a
  // rejected promise, matching the declared type.  The server catches
  // synchronous throws too, but a handler should not lean on that.

  private async onEnable(parameters: unknown): Promise<ExplainStatusResult> {
    const request = parameters as ExplainEnableParameters | undefined;
    const path = requirePath(request?.path);
    const capacity = clampCapacity(request?.capacity);
    this.requireCell(path)._enableExplain(capacity);
    this.enabled.add(path);
    return { path, enabled: true, capacity };
  }

  private async onDisable(parameters: unknown): Promise<ExplainStatusResult> {
    const path = requirePath((parameters as ExplainPathParameters | undefined)?.path);
    this.requireCell(path)._disableExplain();
    this.enabled.delete(path);
    return { path, enabled: false, capacity: 0 };
  }

  private async onFetch(parameters: unknown): Promise<ReturnType<typeof explainEntriesPayload>> {
    const path = requirePath((parameters as ExplainPathParameters | undefined)?.path);
    const cell = this.requireCell(path);
    return explainEntriesPayload(
      Date.now(),
      path,
      cell._explainCapacity(),
      cell._explainEntries().map(toExplainEntry),
    );
  }

  /** Resolve a path to a live cell, or explain why it cannot be. */
  private requireCell(path: string): ActorCell<unknown> {
    const cell = this.cellAt(path);
    if (cell === null) throw new Error(`no such actor: ${path}`);
    return cell;
  }

  private cellAt(path: string): ActorCell<unknown> | null {
    const segments = parseSelectionPath(this.system, path);
    if (segments === null) return null;
    return this.system._resolvePath(segments).fold(
      () => null as ActorCell<unknown> | null,
      (ref) => (ref instanceof LocalActorRef ? ref.getCell() : null),
    );
  }
}

function requirePath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('`path` is required and must be an actor path');
  }
  return path;
}

function clampCapacity(capacity: unknown): number {
  if (capacity === undefined) return DEFAULT_EXPLAIN_CAPACITY;
  if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1) {
    throw new Error('`capacity` must be an integer >= 1');
  }
  return Math.min(capacity, MAXIMUM_CAPACITY);
}

function toExplainEntry(entry: MessageExplain): ExplainEntry {
  return {
    sequenceNumber: entry.sequenceNumber,
    atMs: entry.atMs,
    messageType: entry.messageType,
    senderPath: entry.senderPath,
    mailboxWaitMs: entry.mailboxWaitMs,
    handleTimeMs: entry.handleTimeMs,
    outcome: entry.outcome,
    errorMessage: entry.errorMessage,
    spanId: entry.spanId,
  };
}
