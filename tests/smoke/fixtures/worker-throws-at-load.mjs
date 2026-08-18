/**
 * A worker bootstrap that fails the way #700 is about: it throws before it can
 * complete `WorkerCluster`'s hello/init/ready handshake, so the only signal the
 * parent ever gets is the `error` event.
 *
 * Deliberately imports nothing.  A bootstrap that pulled in actor-ts would need
 * the src/dist switch the smoke runner does for itself, and would give the
 * worker handles of its own to leak — this one owns none, so there is nothing
 * for it to release on any path and the parent's `terminate()` is the whole of
 * its teardown.
 */
throw new Error('worker bootstrap refused to start');
