/**
 * Version of the DevTools introspection protocol (#445).
 *
 * The number is the ONLY compatibility signal between the embedded UI
 * and the server tap.  Both sides exchange it in the `hello` / `welcome`
 * handshake and a mismatch closes the socket — a stale bookmarked UI
 * bundle rendering garbage against a newer server is far worse than a
 * blunt "rebuild your UI" banner.
 *
 * **Evolution contract** (documented in `docs/.../devtools/protocol`):
 *
 *   - *Additive* changes keep the version: new frame kinds, new stream
 *     ids, new request methods, new OPTIONAL payload fields.  Clients
 *     MUST ignore frame kinds, streams and fields they do not know, so
 *     an older UI keeps working against a newer server.
 *   - *Breaking* changes bump it: removing or renaming anything, or
 *     changing the meaning/type of an existing field.
 *
 * That is why the whole surface — including the streams and request
 * methods whose panels land in later phases (#217, #218, #201, #226) —
 * is declared here up front: the shape is agreed once, and every panel
 * that follows is a pure addition.
 *
 * **History.**  Version 2 (#1546) widened `ConfigSource` — the type of the
 * existing `source` field of every `config.resolved` entry — from three
 * names to five, adding `profile` and `secrets`.  Additive as it looks, it
 * is a type change by the rule above: a version-1 UI maps a source through
 * a table keyed by the three names it knows, and would render the two new
 * ones as nothing.
 */
export const DEVTOOLS_PROTOCOL_VERSION = 2;
