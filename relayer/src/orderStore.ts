import { Order, OrderSide } from "./types";

/**
 * Order storage — keeps order preimages off-chain for settlement.

 *
 * In-memory implementation for devnet. Production: Redis with 7-day TTL.
 */

export interface OrderStore {
  save(batchId: string, key: string, order: Order): Promise<void>;
  load(batchId: string): Promise<Map<string, Order>>;
  count(batchId: string): Promise<number>;
  delete(batchId: string): Promise<void>;
}

export class InMemoryOrderStore implements OrderStore {
  private store: Map<string, Map<string, Order>> = new Map();

  async save(batchId: string, key: string, order: Order): Promise<void> {
    if (!this.store.has(batchId)) {
      this.store.set(batchId, new Map());
    }
    this.store.get(batchId)!.set(key, order);
  }

  async load(batchId: string): Promise<Map<string, Order>> {
    return this.store.get(batchId) || new Map();
  }

  async count(batchId: string): Promise<number> {
    return this.store.get(batchId)?.size || 0;
  }

  async delete(batchId: string): Promise<void> {
    this.store.delete(batchId);
  }
}
