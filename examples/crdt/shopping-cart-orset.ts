/**
 * Shopping cart over an OR-Set CRDT — the classic "add wins under
 * concurrent edits" demo.
 *
 * Two replicas of the same cart see each other's adds and removes
 * without coordination.  When A removes an item at the same time
 * B re-adds it, the merged cart still contains the item — because
 * the OR-Set tags B's add with a fresh marker A never observed.
 *
 * No cluster needed for this example — we just merge two local
 * CRDTs to keep the script self-contained.  For the full
 * gossip-replicated story see `tests/multi-node/distributed-data.test.ts`.
 *
 *   bun run examples/crdt/shopping-cart-orset.ts
 */
import { ORSet } from '../../src/crdt/index.js';

interface Item {
  readonly sku: string;
  readonly name: string;
}

function show(label: string, cart: ORSet<Item>): void {
  const items = cart.value();
  console.log(`${label}: { ${items.map((i) => `${i.sku}:${i.name}`).join(', ') || '∅'} }`);
}

function main(): void {
  const REPLICA_A = 'tab-a';
  const REPLICA_B = 'tab-b';

  // Both replicas start empty; user opens two tabs editing the same cart.
  let cartA = ORSet.empty<Item>();
  let cartB = ORSet.empty<Item>();

  // Tab A adds two items, tab B mirrors via gossip.
  cartA = cartA.add(REPLICA_A, { sku: 'BOOK-1', name: 'Designing Data-Intensive Applications' });
  cartA = cartA.add(REPLICA_A, { sku: 'COFFEE', name: 'Single-origin Ethiopian' });
  cartB = cartB.merge(cartA);
  show('after sync', cartB);

  // Concurrent edit:
  //   - Tab A removes the coffee.
  //   - Tab B independently *re-adds* the coffee (maybe a different
  //     blend, but same SKU — same JSON identity).
  // Without OR-Set semantics, "remove vs add" is order-dependent and
  // either side could win.  With OR-Set, the add carries a fresh tag
  // that A's remove can't see, so the item survives.
  const aAfterRemove = cartA.remove({ sku: 'COFFEE', name: 'Single-origin Ethiopian' });
  const bAfterReadd  = cartB.add(REPLICA_B, { sku: 'COFFEE', name: 'Single-origin Ethiopian' });

  show('A locally  ', aAfterRemove);
  show('B locally  ', bAfterReadd);

  // Gossip catches up — both replicas merge each other's state.
  const converged = aAfterRemove.merge(bAfterReadd);
  show('converged  ', converged);

  // The whole point: order doesn't matter — merge in the other
  // direction yields the same result.
  const reverse = bAfterReadd.merge(aAfterRemove);
  console.log(
    `\nmerge order independent? ${
      JSON.stringify(converged.toJSON()) === JSON.stringify(reverse.toJSON())
    }`,
  );

  // Sanity: merging the same state twice is a no-op.
  console.log(
    `idempotent (merge(c, c) === c)? ${
      JSON.stringify(converged.merge(converged).toJSON())
        === JSON.stringify(converged.toJSON())
    }`,
  );
}

main();
