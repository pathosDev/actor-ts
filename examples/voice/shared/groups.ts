/**
 * Hardcoded group → members mapping for the voice sample.
 *
 * Static membership simplifies the demo: at login a user can be
 * resolved to a group list with a synchronous lookup, and the
 * VoiceSessionActor subscribes to each `voice.group.<name>` PubSub
 * topic immediately.  No CRDT churn for membership, no UI for
 * group management.  A follow-up could introduce DD-backed dynamic
 * groups; out of scope here.
 *
 * The group set deliberately overlaps so cross-membership is
 * exercised: `alice` is in both `engineering` and `product`, etc.
 */

import { TEST_USERS, type TestUser } from './users.js';

export const GROUPS = {
  engineering: ['alice', 'bob']     as const,
  ops:         ['charlie', 'diana'] as const,
  product:     ['alice', 'diana']   as const,
} as const;

export type GroupName = keyof typeof GROUPS;

export const GROUP_NAMES = Object.keys(GROUPS) as ReadonlyArray<GroupName>;

/** Groups that contain `username` (hardcoded lookup; static membership). */
export function groupsForUser(username: string): GroupName[] {
  return GROUP_NAMES.filter(
    (g) => (GROUPS[g] as ReadonlyArray<string>).includes(username),
  );
}

/** True if `s` is a known group name. */
export function isGroupName(s: unknown): s is GroupName {
  return typeof s === 'string' && (GROUP_NAMES as ReadonlyArray<string>).includes(s);
}

/** Type-narrowed accessor that's safe at runtime. */
export function membersOf(group: GroupName): ReadonlyArray<TestUser['username']> {
  return GROUPS[group];
}

void TEST_USERS; // re-asserts the user list exists for type inference
