import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { Props } from '../../../src/Props.js';
import { TestKit } from '../../../src/testkit/TestKit.js';

describe('TestProbe basics', () => {
  test('captures messages in FIFO order', async () => {
    const tk = TestKit.create('probe-fifo');
    const probe = tk.createTestProbe();
    probe.tell('a'); probe.tell('b'); probe.tell('c');
    expect(probe.messageCount).toBe(3);
    expect(probe.hasMessage()).toBe(true);
    expect(await probe.receiveOne(50)).toBe('a');
    expect(await probe.receiveOne(50)).toBe('b');
    expect(await probe.receiveOne(50)).toBe('c');
    expect(probe.hasMessage()).toBe(false);
    await tk.shutdown();
  });

  test('expectMsg passes on equal value, throws otherwise', async () => {
    const tk = TestKit.create();
    const probe = tk.createTestProbe();
    probe.tell({ cmd: 'ping' });
    await probe.expectMsg({ cmd: 'ping' }, 100);
    probe.tell({ cmd: 'ping' });
    await expect(probe.expectMsg({ cmd: 'pong' }, 100))
      .rejects.toThrow(/expectMsg/);
    await tk.shutdown();
  });

  test('expectMsgType checks instance', async () => {
    class OrderPlaced { constructor(public readonly id: string) {} }
    const tk = TestKit.create();
    const probe = tk.createTestProbe();
    probe.tell(new OrderPlaced('o-1'));
    const msg = await probe.expectMsgType(OrderPlaced, 100);
    expect(msg.id).toBe('o-1');

    probe.tell('not-an-OrderPlaced');
    await expect(probe.expectMsgType(OrderPlaced, 100))
      .rejects.toThrow(/expectMsgType/);

    await tk.shutdown();
  });

  test('expectNoMessage passes when nothing arrives', async () => {
    const tk = TestKit.create();
    const probe = tk.createTestProbe();
    await probe.expectNoMessage(30);
    await tk.shutdown();
  });

  test('expectNoMessage throws if a message arrives', async () => {
    const tk = TestKit.create();
    const probe = tk.createTestProbe();
    setTimeout(() => probe.tell('boom'), 5);
    await expect(probe.expectNoMessage(50)).rejects.toThrow(/received/);
    await tk.shutdown();
  });

  test('receiveN fetches N messages in order', async () => {
    const tk = TestKit.create();
    const probe = tk.createTestProbe();
    probe.tell(1); probe.tell(2); probe.tell(3);
    expect(await probe.receiveN(3, 100)).toEqual([1, 2, 3]);
    await tk.shutdown();
  });

  test('fishForMessage skips non-matching messages', async () => {
    const tk = TestKit.create();
    const probe = tk.createTestProbe();
    probe.tell('noise-1'); probe.tell('target'); probe.tell('noise-2');
    const got = await probe.fishForMessage((m): m is string => m === 'target', 200);
    expect(got).toBe('target');
    await tk.shutdown();
  });

  test('receiveOne times out when no message arrives', async () => {
    const tk = TestKit.create();
    const probe = tk.createTestProbe();
    await expect(probe.receiveOne(30)).rejects.toThrow(/timeout/i);
    await tk.shutdown();
  });

  test('sender records the originator of the last message', async () => {
    const tk = TestKit.create();
    const p = tk.createTestProbe({ name: 'from' });
    const to = tk.createTestProbe({ name: 'to' });
    to.tell('msg', p);
    await to.receiveOne(100);
    expect(to.sender).toBe(p);
    await tk.shutdown();
  });

  test('reply sends to the last sender', async () => {
    const tk = TestKit.create();
    const sender = tk.createTestProbe({ name: 'sender' });
    const replier = tk.createTestProbe({ name: 'replier' });
    replier.tell('ping', sender);
    await replier.receiveOne(100);
    replier.reply('pong');
    expect(await sender.receiveOne(100)).toBe('pong');
    await tk.shutdown();
  });

  test('reply throws if no sender has been recorded', async () => {
    const tk = TestKit.create();
    const probe = tk.createTestProbe();
    expect(() => probe.reply('anything')).toThrow(/no sender/);
    await tk.shutdown();
  });

  test('clearInbox drops buffered messages', async () => {
    const tk = TestKit.create();
    const probe = tk.createTestProbe();
    probe.tell('a'); probe.tell('b');
    probe.clearInbox();
    await probe.expectNoMessage(30);
    await tk.shutdown();
  });
});

describe('TestProbe integrates with real actors', () => {
  test('an actor can reply to a probe as if it were a regular ref', async () => {
    class Echo extends Actor<string> {
      override onReceive(m: string): void { this.sender.forEach((__s) => __s.tell(`echo:${m}`)); }
    }
    const tk = TestKit.create();
    const probe = tk.createTestProbe();
    const ref = tk.system.spawn(Props.create(() => new Echo()), 'echo');
    ref.tell('hi', probe);
    expect(await probe.receiveOne(200)).toBe('echo:hi');
    await tk.shutdown();
  });
});

describe('TestKit.within', () => {
  test('passes when the body finishes inside the window', async () => {
    const tk = TestKit.create();
    await tk.within(100, async () => { await Bun.sleep(10); });
    await tk.shutdown();
  });

  test('throws when the body exceeds the window', async () => {
    const tk = TestKit.create();
    await expect(tk.within(20, async () => { await Bun.sleep(50); }))
      .rejects.toThrow(/exceeded/);
    await tk.shutdown();
  });
});
