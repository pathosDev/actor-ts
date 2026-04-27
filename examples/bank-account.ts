/**
 * Bank account with the ask pattern.  Shows:
 *   - State held inside an actor.
 *   - Request/response via ask.
 *   - Sending Error as a reply to reject an ask.
 *
 *   tsx examples/bank-account.ts
 */
import { match } from 'ts-pattern';
import { Actor, ActorSystem, Props, ask } from '../src/index.js';

type Command =
  | { kind: 'deposit'; amount: number }
  | { kind: 'withdraw'; amount: number }
  | { kind: 'balance' };

class AccountActor extends Actor<Command> {
  private balance = 0;

  override onReceive(cmd: Command): void {
    const reply = (msg: unknown): void => this.sender.forEach((s) => s.tell(msg));

    match(cmd)
      .with({ kind: 'deposit' }, (c) => {
        if (c.amount <= 0) { reply(new Error(`deposit must be > 0, got ${c.amount}`)); return; }
        this.balance += c.amount;
        reply({ balance: this.balance });
      })
      .with({ kind: 'withdraw' }, (c) => {
        if (c.amount > this.balance) {
          reply(new Error(`insufficient funds: have ${this.balance}, need ${c.amount}`));
          return;
        }
        this.balance -= c.amount;
        reply({ balance: this.balance });
      })
      .with({ kind: 'balance' }, () => reply({ balance: this.balance }))
      .exhaustive();
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('bank');
  const account = system.actorOf(Props.create(() => new AccountActor()), 'alice');

  console.log('deposit 100 ->', await ask(account, { kind: 'deposit', amount: 100 }, 500));
  console.log('withdraw 30 ->', await ask(account, { kind: 'withdraw', amount: 30 }, 500));
  console.log('balance     ->', await ask(account, { kind: 'balance' }, 500));

  try {
    await ask(account, { kind: 'withdraw', amount: 999 }, 500);
  } catch (e) {
    console.log('withdraw 999 rejected as expected:', (e as Error).message);
  }

  await system.terminate();
}

void main();
