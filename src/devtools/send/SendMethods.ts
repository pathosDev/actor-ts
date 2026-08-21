/**
 * The send-message action (#553).
 *
 * DevTools reads.  This one writes, and everything about its shape
 * follows from that: it is off unless the operator acknowledged it in
 * code, the acknowledgement is a separate flag from the panel toggle,
 * and when it is off this class is never constructed — so the method is
 * not registered and a client that knows its name is told there is no
 * such method rather than being refused by a guard it might argue with.
 *
 * @see DevToolsOptionsType.allowMessageSending
 */
import type { ActorSystem } from '../../ActorSystem.js';
import { parseSelectionPath } from '../../ActorSelection.js';
import { SEND_MESSAGE_MAX_BYTES, type SendMessageParameters, type SendMessageResult } from '../protocol/index.js';
import type { DevToolsServer } from '../DevToolsServer.js';

/** Wires `actors.send` onto the server. */
export class SendMethods {
  constructor(private readonly system: ActorSystem) {}

  /** Register the method on `server`.  Only called when enabled. */
  install(server: DevToolsServer): void {
    server.registerMethod('actors.send', (parameters) => this.onSend(parameters));
  }

  private async onSend(parameters: unknown): Promise<SendMessageResult> {
    const request = parameters as SendMessageParameters | undefined;
    const path = requirePath(request?.path);
    const message = parseBody(request?.body);

    const segments = parseSelectionPath(this.system, path);
    if (segments === null) throw new Error(`not an actor path: ${path}`);
    requireUserActor(segments, path);

    const reference = this.system._resolvePath(segments);
    if (!reference.isSome()) throw new Error(`no such actor: ${path}`);

    // No sender: a reply would go to dead letters, and forging one would
    // point the recipient's `sender` at an actor that never sent anything.
    reference.value.tell(message as never, null);
    return {
      path: reference.value.path.toString(),
      messageType: messageTypeOf(message),
      atMs: Date.now(),
    };
  }
}

function requirePath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('`path` is required and must be an actor path');
  }
  return path;
}

/**
 * Refuse anything outside the user guardian.
 *
 * System actors are the framework's own machinery — mailboxes, the
 * cluster's gossip, DevTools' own hub.  A hand-written JSON message to
 * one is at best ignored, and this is a write endpoint reachable from a
 * browser, so the narrow rule is the right one.
 */
function requireUserActor(segments: ReadonlyArray<string>, path: string): void {
  // `parseSelectionPath` strips the scheme and the system name, so the
  // guardian is the first segment: `/user/orders` -> ['user', 'orders'].
  if (segments[0] !== 'user' || segments.length < 2) {
    throw new Error(`only actors under /user can be sent to, not ${path}`);
  }
}

/**
 * Parse the body, bounded and shape-checked.
 *
 * An actor's message is almost always an object with a `kind`, and a
 * bare string or number reaching `onReceive` is far more likely to be a
 * mistyped body than an intention.  Objects and arrays only, therefore —
 * a refusal here is cheaper than a handler that throws inside a live
 * actor.
 */
function parseBody(body: unknown): object {
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new Error('`body` is required and must be JSON text');
  }
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > SEND_MESSAGE_MAX_BYTES) {
    throw new Error(`\`body\` is ${bytes} bytes; the limit is ${SEND_MESSAGE_MAX_BYTES}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new Error(`\`body\` is not valid JSON: ${(cause as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('`body` must be a JSON object or array, not a bare value');
  }
  return parsed;
}

/** Name the message the way the panels that show it will. */
function messageTypeOf(message: object): string {
  if (Array.isArray(message)) return 'Array';
  const kind = (message as { kind?: unknown }).kind;
  // A `kind` is this project's discriminant, so it is the useful name when
  // there is one — every panel that lists messages shows a type, and
  // "Object" for all of them would be no answer at all.
  return typeof kind === 'string' && kind.length > 0 ? kind : 'Object';
}
