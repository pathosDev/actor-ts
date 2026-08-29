/**
 * Hello Receptionist: register a service under a ServiceKey on one node
 * and look it up via Find.  Works with or without a cluster — the null
 * cluster argument disables gossip and keeps everything local.
 *
 *   bun run examples/discovery/receptionist-hello.ts
 */
import {
  Actor,
  ActorSystem,
} from '../../src/index.js';
import {
  Find,
  Listing,
  ReceptionistId,
  Register,
  ServiceKey,
} from '../../src/discovery/index.js';

class Echo extends Actor<string> {
  override onReceive(m: string): void { console.log(`[echo] received ${m}`); }
}

class Client extends Actor<Listing<string>> {
  override onReceive(listing: Listing<string>): void {
    console.log(`[client] listing for ${listing.key.id}: ${listing.refs.length} ref(s)`);
    for (const r of listing.refs) r.tell('hi from client');
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('recp-hello');
  const receptionist = system.extension(ReceptionistId).start(null);

  const echoKey = ServiceKey.of<string>('echo');
  const echo = system.spawn(Echo, 'echo');
  receptionist.tell(new Register(echoKey, echo));

  const client = system.spawn(Client, 'client');
  receptionist.tell(new Find(echoKey, client));

  // Not a drain sleep, and measurably load-bearing: the receptionist is a
  // `/system` actor, and terminate() only drains `/user`.  Both tells above
  // land in a mailbox the drain never inspects, so without this the echo
  // reply is lost — it survived 2 runs in 12 when the wait was removed.
  await Bun.sleep(50);
  await system.terminate();
}

void main();
