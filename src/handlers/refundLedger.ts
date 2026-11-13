import type { RefundRequested } from '../bus/events';
import type { Message, Subscriber } from '../bus/inMemoryBus';
import type { PaymentGateway } from '../integrations/paymentGateway';

/** One line in the refund ledger. */
export interface LedgerEntry {
  entryId: string;
  bookingId: string;
  organizer: string;
  amountCents: number;
  reason: string;
  recordedAtMinute: number;
}

/**
 * Books refunds and sends the money back.
 *
 * For a refund message the handler writes a ledger entry, then calls the
 * payment provider for the same amount. The ledger is append only: entries are
 * numbered in the order they were written, and nothing edits or removes one
 * after the fact.
 */
export class RefundLedger implements Subscriber<RefundRequested> {
  readonly name = 'RefundLedger';

  private readonly entries: LedgerEntry[] = [];
  private readonly gateway: PaymentGateway;
  /** Message ids whose ledger entry has been written. */
  private readonly booked = new Set<string>();
  /** Message ids whose refund the payment provider has accepted. */
  private readonly paid = new Set<string>();

  constructor(gateway: PaymentGateway) {
    this.gateway = gateway;
  }

  /**
   * Safe to deliver more than once. The message id is the idempotency key, and
   * the two steps are tracked separately: a delivery that wrote the ledger
   * entry but died at the provider leaves the id in `booked` but not in
   * `paid`, so a redelivery retries only the provider call.
   */
  handle(message: Message<RefundRequested>): void {
    const event = message.payload;
    if (!this.booked.has(message.id)) {
      this.entries.push({
        entryId: `led-${this.entries.length + 1}`,
        bookingId: event.bookingId,
        organizer: event.organizer,
        amountCents: event.amountCents,
        reason: event.reason,
        recordedAtMinute: message.publishedAtMinute,
      });
      this.booked.add(message.id);
    }
    if (!this.paid.has(message.id)) {
      this.gateway.refund(event.bookingId, event.amountCents);
      this.paid.add(message.id);
    }
  }

  /** Every ledger entry, oldest first. */
  all(): LedgerEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** Entries for one booking, oldest first. */
  forBooking(bookingId: string): LedgerEntry[] {
    return this.all().filter((entry) => entry.bookingId === bookingId);
  }

  /** What the ledger says has been refunded, in cents. */
  totalRefundedCents(): number {
    return this.entries.reduce((sum, entry) => sum + entry.amountCents, 0);
  }

  size(): number {
    return this.entries.length;
  }
}
