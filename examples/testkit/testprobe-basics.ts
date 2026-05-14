/**
 * TestProbe basics: assert that an actor emits the right messages.
 *
 *   bun run examples/testkit/testprobe-basics.ts
 */
import { Actor, Props, TestKit } from '../../src/index.js';

class Counter extends Actor<'inc' | 'report'> {
  private n = 0;
  override onReceive(msg: 'inc' | 'report'): void {
    if (msg === 'inc') this.n++;
    else this.sender.forEach((__s) => __s.tell({ kind: 'count', value: this.n }));
  }
}

async function main(): Promise<void> {
  const tk = TestKit.create('testprobe-demo');
  const probe = tk.createTestProbe();
  const counter = tk.system.spawn(Props.create(() => new Counter()), 'counter');

  counter.tell('inc');
  counter.tell('inc');
  counter.tell('inc');
  counter.tell('report', probe);     // probe is the sender

  const reply = await probe.receiveOne(100);
  console.log('counter replied:', reply);          // → { kind: 'count', value: 3 }
  console.log('reply sender was :', probe.sender?.path.toString());

  await tk.shutdown();
}

void main();
