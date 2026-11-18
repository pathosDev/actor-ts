let lastIssued = 0;

/**
 * A shard freshness token for a `HandOff` or `ShardHome` a test hands a region
 * in its coordinator's place (#1214).
 *
 * A region refuses a `HandOff` whose token is not newer than the last one it
 * saw for the shard, and the real coordinator draws its tokens no lower than
 * its wall clock.  So the tokens drawn here grow strictly across every call in
 * the process, and each one is above the clock as it stands when it is drawn:
 * a directive a test sends after the coordinator's own is newer than it.
 */
export function nextShardToken(): number {
  lastIssued = Math.max(lastIssued + 1, Date.now() + 1);
  return lastIssued;
}
