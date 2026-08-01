/**
 * The time-travel methods (#201) — browse a journal, reconstruct state.
 *
 * Strictly read-only: nothing here writes a journal, a snapshot store
 * or a live actor.  "What did this look like at sequence N?" is a
 * question, and answering it must not change the answer.
 *
 * Request/response rather than a stream, because this is driven by a
 * human dragging a slider, not by the system emitting events.
 */
import type { PersistenceExtension } from '../../persistence/PersistenceExtension.js';
import { replayState } from '../../persistence/Replay.js';
import { isEnvelope } from '../../persistence/migration/Envelope.js';
import { toWireValue } from '../internal/WireSerializer.js';
import type {
  JournalEventView,
  JournalIdentifierInfo,
  JournalIdentifiersParameters,
  JournalIdentifiersResult,
  JournalReadParameters,
  JournalReadResult,
  ReplayCapabilitiesParameters,
  ReplayCapabilitiesResult,
  ReplayDiffParameters,
  ReplayDiffResult,
  ReplayStateParameters,
  ReplayStateResult,
} from '../protocol/index.js';
import type { DevToolsServer } from '../DevToolsServer.js';
import type { ReplayRegistry } from './ReplayRegistry.js';

/** Persistence ids returned per page. */
const DEFAULT_IDENTIFIER_LIMIT = 100;
/** Events returned per page — a journal can be enormous. */
const DEFAULT_EVENT_LIMIT = 200;
const MAXIMUM_EVENT_LIMIT = 2_000;

export class TimeTravelMethods {
  constructor(
    private readonly persistence: PersistenceExtension,
    private readonly registry: ReplayRegistry,
  ) {}

  install(server: DevToolsServer): void {
    server.registerMethod('journal.ids', (p) => this.onJournalIdentifiers(p));
    server.registerMethod('journal.read', (p) => this.onJournalRead(p));
    server.registerMethod('replay.capabilities', (p) => this.onReplayCapabilities(p));
    server.registerMethod('replay.state', (p) => this.onReplayState(p));
    server.registerMethod('replay.diff', (p) => this.onReplayDiff(p));
  }

  private async onJournalIdentifiers(parameters: unknown): Promise<JournalIdentifiersResult> {
    const request = (parameters ?? {}) as JournalIdentifiersParameters;
    const offset = nonNegativeInteger(request.offset, 0, 'offset');
    const limit = boundedLimit(request.limit, DEFAULT_IDENTIFIER_LIMIT, MAXIMUM_EVENT_LIMIT, 'limit');

    const all = [...await this.persistence.journal.persistenceIds()].sort();
    const page = all.slice(offset, offset + limit);
    const identifiers: JournalIdentifierInfo[] = await Promise.all(page.map(async (persistenceId) => ({
      persistenceId,
      highestSequenceNumber: await this.persistence.journal.highestSeq(persistenceId),
      capability: this.registry.capabilityOf(persistenceId),
    })));
    return { identifiers, total: all.length, offset };
  }

  private async onJournalRead(parameters: unknown): Promise<JournalReadResult> {
    const request = (parameters ?? {}) as JournalReadParameters;
    const persistenceId = requireIdentifier(request.persistenceId);
    const from = nonNegativeInteger(request.fromSequenceNumber, 1, 'fromSequenceNumber');
    const limit = boundedLimit(request.limit, DEFAULT_EVENT_LIMIT, MAXIMUM_EVENT_LIMIT, 'limit');
    const highest = await this.persistence.journal.highestSeq(persistenceId);
    // Cap the window ourselves: an unbounded read of a million-event
    // journal would be answered eventually, and uselessly.
    const to = Math.min(
      request.toSequenceNumber ?? from + limit - 1,
      from + limit - 1,
    );

    const events = await this.persistence.journal.read<unknown>(persistenceId, from, to);
    return {
      persistenceId,
      highestSequenceNumber: highest,
      events: events.map((entry) => toEventView(entry)),
    };
  }

  private async onReplayCapabilities(parameters: unknown): Promise<ReplayCapabilitiesResult> {
    const persistenceId = requireIdentifier(
      (parameters as ReplayCapabilitiesParameters | undefined)?.persistenceId,
    );
    return {
      persistenceId,
      capability: this.registry.capabilityOf(persistenceId),
      foldSource: this.registry.sourceOf(persistenceId),
    };
  }

  private async onReplayState(parameters: unknown): Promise<ReplayStateResult> {
    const request = (parameters ?? {}) as ReplayStateParameters;
    const persistenceId = requireIdentifier(request.persistenceId);
    const toSequenceNumber = nonNegativeInteger(request.toSequenceNumber, 0, 'toSequenceNumber');
    return this.replayTo(persistenceId, toSequenceNumber);
  }

  private async onReplayDiff(parameters: unknown): Promise<ReplayDiffResult> {
    const request = (parameters ?? {}) as ReplayDiffParameters;
    const persistenceId = requireIdentifier(request.persistenceId);
    const from = nonNegativeInteger(request.fromSequenceNumber, 0, 'fromSequenceNumber');
    const to = nonNegativeInteger(request.toSequenceNumber, 0, 'toSequenceNumber');
    // Both endpoints, whole: the field-level diff is computed in the
    // UI, which keeps the server a dumb read-only data source.
    return {
      persistenceId,
      from: await this.replayTo(persistenceId, from),
      to: await this.replayTo(persistenceId, to),
    };
  }

  private async replayTo(persistenceId: string, toSequenceNumber: number): Promise<ReplayStateResult> {
    const resolved = this.registry.resolve(persistenceId);
    if (resolved === null) {
      throw new Error(
        `no fold known for '${persistenceId}' — register one in DevToolsOptions.replayFolds, `
        + 'or start the actor that owns it',
      );
    }
    const result = await replayState({
      journal: this.persistence.journal,
      snapshotStore: this.persistence.snapshotStore,
      persistenceId,
      initialState: () => resolved.initialState(),
      fold: (state, event) => resolved.fold(state, event),
      toSequenceNr: toSequenceNumber,
      ...(resolved.eventAdapter === undefined ? {} : { eventAdapter: resolved.eventAdapter }),
      ...(resolved.snapshotAdapter === undefined ? {} : { snapshotAdapter: resolved.snapshotAdapter }),
    });
    const wire = toWireValue(result.state);
    return {
      persistenceId,
      sequenceNumber: result.sequenceNr,
      state: wire.value,
      fromSnapshotSequenceNumber: result.fromSnapshotSequenceNr,
      eventsApplied: result.eventsApplied,
      truncated: wire.truncated,
    };
  }
}

/**
 * Project one journal entry for the wire, unwrapping a migration
 * envelope so the panel shows the payload rather than the wrapper —
 * while still reporting the manifest and version, which are exactly
 * what you want when a migration is the thing under suspicion.
 */
function toEventView(entry: {
  sequenceNr: number;
  timestamp: number;
  tags?: ReadonlyArray<string>;
  event: unknown;
}): JournalEventView {
  const enveloped = isEnvelope(entry.event);
  const payload = enveloped ? (entry.event as { _e: unknown })._e : entry.event;
  const wire = toWireValue(payload);
  return {
    sequenceNumber: entry.sequenceNr,
    timestampMs: entry.timestamp,
    tags: entry.tags === undefined ? [] : [...entry.tags],
    manifest: enveloped ? (entry.event as { _t: string })._t : null,
    schemaVersion: enveloped ? (entry.event as { _v: number })._v : null,
    payload: wire.value,
    truncated: wire.truncated,
  };
}

function requireIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('`persistenceId` is required');
  }
  return value;
}

function nonNegativeInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`\`${field}\` must be a non-negative integer`);
  }
  return value;
}

function boundedLimit(value: unknown, fallback: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`\`${field}\` must be an integer >= 1`);
  }
  return Math.min(value, maximum);
}
