import { describe, expect, test } from 'bun:test';
import { Member } from '../../src/cluster/Member.js';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';
import type { MemberStatus } from '../../src/cluster/Protocol.js';

const addr = new NodeAddress('demo', 'h', 1);

describe('Member', () => {
  test('constructor captures address, status, version, roles', () => {
    const member = new Member(addr, 'up', 3, ['backend', 'worker']);
    expect(member.address.equals(addr)).toBe(true);
    expect(member.status).toBe('up');
    expect(member.version).toBe(3);
    expect(Array.from(member.roles).sort()).toEqual(['backend', 'worker']);
  });

  test('roles default to empty set', () => {
    const member = new Member(addr, 'up', 1);
    expect(member.roles.size).toBe(0);
  });

  test('hasRole returns true only for registered roles', () => {
    const member = new Member(addr, 'up', 1, ['backend']);
    expect(member.hasRole('backend')).toBe(true);
    expect(member.hasRole('frontend')).toBe(false);
  });

  test('isReachable truth table', () => {
    const matrix: Array<[MemberStatus, boolean]> = [
      ['joining', true],
      ['up', true],
      ['leaving', true],
      ['unreachable', false],
      ['down', false],
      ['removed', false],
    ];
    for (const [status, expected] of matrix) {
      expect(new Member(addr, status, 1).isReachable()).toBe(expected);
    }
  });

  test('withStatus returns new instance with bumped version', () => {
    const memberA = new Member(addr, 'joining', 1, ['x']);
    const memberB = memberA.withStatus('up');
    expect(memberA.status).toBe('joining');
    expect(memberA.version).toBe(1);
    expect(memberB.status).toBe('up');
    expect(memberB.version).toBe(2);
    expect(memberB.address.equals(memberA.address)).toBe(true);
  });

  test('withStatus preserves roles', () => {
    const memberA = new Member(addr, 'joining', 1, ['backend', 'hot']);
    const memberB = memberA.withStatus('up');
    expect(Array.from(memberB.roles).sort()).toEqual(['backend', 'hot']);
  });

  test('toData + fromData round-trips fields and roles', () => {
    const original = new Member(addr, 'up', 7, ['backend']);
    const data = original.toData();
    expect(data.status).toBe('up');
    expect(data.version).toBe(7);
    expect(data.roles).toEqual(['backend']);
    expect(data.address).toEqual(addr.toJSON());

    const restored = Member.fromData(data);
    expect(restored.address.equals(original.address)).toBe(true);
    expect(restored.status).toBe(original.status);
    expect(restored.version).toBe(original.version);
    expect(Array.from(restored.roles)).toEqual(Array.from(original.roles));
  });

  test('fromData without roles field yields empty role set', () => {
    const restored = Member.fromData({
      address: addr.toJSON(),
      status: 'up',
      version: 1,
    });
    expect(restored.roles.size).toBe(0);
  });

  test('toString includes address, status, version, roles', () => {
    const member = new Member(addr, 'up', 3, ['backend']);
    const text = member.toString();
    expect(text).toContain(addr.toString());
    expect(text).toContain('up');
    expect(text).toContain('v3');
    expect(text).toContain('backend');
  });

  test('toString omits roles tag when none are set', () => {
    const member = new Member(addr, 'up', 1);
    expect(member.toString()).not.toContain('roles=');
  });

  test('roles set is a fresh Set per member (no aliasing)', () => {
    const rolesIn = ['a', 'b'];
    const member = new Member(addr, 'up', 1, rolesIn);
    rolesIn.push('c');
    expect(member.roles.has('c')).toBe(false);
  });
});
