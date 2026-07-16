/**
 * Bank account with the ask pattern.  Shows:
 *   - State held inside an actor.
 *   - Request/response via ask.
 *   - Sending Error as a reply to reject an ask.
 *
 *   tsx examples/bank-account.ts
 */
import { match } from 'ts-pattern';
import { Actor, ActorSystem, Props } from '../src/index.js';

type DepositCommand = { kind: 'deposit'; amount: number };
type WithdrawCommand = { kind: 'withdraw'; amount: number };
type BalanceCommand = { kind: 'balance' };
type Command = DepositCommand | WithdrawCommand | BalanceCommand;

class AccountActor extends Actor<Command> {
  private balance = 0;

  override onReceive(cmd: Command): void {
    match(cmd)
      .with({ kind: 'deposit' }, (c) => this.onDeposit(c))
      .with({ kind: 'withdraw' }, (c) => this.onWithdraw(c))
      .with({ kind: 'balance' }, () => this.onBalance())
      .exhaustive();
  }

  private reply(msg: unknown): void {
    this.sender.forEach((s) => s.tell(msg));
  }

  private onDeposit(c: DepositCommand): void {
    if (c.amount <= 0) { this.reply(new Error(`deposit must be > 0, got ${c.amount}`)); return; }
    this.balance += c.amount;
    this.reply({ balance: this.balance });
  }

  private onWithdraw(c: WithdrawCommand): void {
    if (c.amount > this.balance) {
      this.reply(new Error(`insufficient funds: have ${this.balance}, need ${c.amount}`));
      return;
    }
    this.balance -= c.amount;
    this.reply({ balance: this.balance });
  }

  private onBalance(): void {
    this.reply({ balance: this.balance });
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('bank');
  const account = system.spawn(Props.create(() => new AccountActor()), 'alice');

  console.log('deposit 100 ->', await account.ask({ kind: 'deposit', amount: 100 }, 500));
  console.log('withdraw 30 ->', await account.ask({ kind: 'withdraw', amount: 30 }, 500));
  console.log('balance     ->', await account.ask({ kind: 'balance' }, 500));

  try {
    await account.ask({ kind: 'withdraw', amount: 999 }, 500);
  } catch (e) {
    console.log('withdraw 999 rejected as expected:', (e as Error).message);
  }

  await system.terminate();
}

void main();
