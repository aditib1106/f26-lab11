# EVENTS.md

## Milestone 1: what runs in the request path, and what runs after it

### The operations table

| # | Operation | As wired today | Your call | Why (in one line) |
|---|---|---|---|---|
| 1 | Index the booking in the search cluster (`searchIndex.indexBooking`, `bookingService.ts:94`) | Synchronous, inside `book()`, before `store.save` | Event: subscribe an indexer to `booking.confirmed` | The room-finder page is a derived view; a booking should not depend on it being up. |
| 2 | Validate the request and check for a clash (`validateRequest`, `conflictingBooking`) | Synchronous, inside `book()` | Stay synchronous | The caller needs the yes/no now, and it guards the no-double-booking rule. |
| 3 | Write the booking to the store (`store.save`) | Synchronous, inside `book()` | Stay synchronous | It is the booking itself; the caller cannot be told "confirmed" without it. |
| 4 | Audit record (`audit.record`) | Synchronous, inside `book()`/`cancel()` | Stay synchronous | In-process append that must match what just happened; it has no network dependency that can fail. |
| 5 | Confirmation / release email (`EmailConfirmationHandler`) | Event: `booking.confirmed`, `booking.cancelled` | Stay an event | The organizer needs it soon, not before the page answers; a mail relay outage must not block booking. |
| 6 | Receipt (`ReceiptGenerator`) | Event: `booking.confirmed` | Stay an event | Downloaded later, and re-rendering from the store is harmless on replay. |
| 7 | Refund ledger entry and provider call (`RefundLedger`) | Event: `refund.requested` | Stay an event, but idempotent | Cancel should not hang on the payment provider, but the money step must survive redelivery. |
| 8 | Dashboard counts (`StatsUpdater`) | Event: both booking events | Stay an event | Pure recount from the store, so late or repeated delivery changes nothing. |

### Two calls in detail

**Search indexing (row 1), the operation the ticket implicates.** The person
booking a room needs to know whether the room is theirs, and needs it now: the
answer depends on validation, the clash check and the store write, and nothing
else. The search index is a read model the room-finder page uses to find
bookings, so it is a consequence of a booking and not a part of it. Today
`book()` calls `indexBooking` before saving, so when the cluster is down the
call throws `SearchIndexUnavailableError`, nothing is saved, nothing is
published, and the caller gets an unhandled error instead of a `BookingError`.
My call is to move indexing to a `booking.confirmed` subscriber. A booking
would then succeed while the cluster is down, the index would be stale for the
outage, and the failed deliveries would sit in the dead-letter list to be
redelivered when the cluster returns. Indexing is safe to repeat because it
overwrites the row for a booking id.

**Refunds (row 7).** On cancel the organizer needs to be told what they are
owed, and that already comes back from `cancel()` as `refundCents`. Actually
moving the money can take a moment longer, so it is rightly an event: a slow or
down payment provider should not make cancellation hang or fail, and it did not
in the incident. It stays on the bus, but a bus that delivers at least once
means the handler has to tolerate a second delivery of the same message, which
is what milestone 2 is about. A refund is the one handler here where "happens
twice" costs real money.

### The incident

**The call behind `TICKET.md`.** `src/service/bookingService.ts`, method
`book()`, line 94: `this.searchIndex.indexBooking(booking, room, now);`. When
the search cluster is down, `indexBooking` throws
`SearchIndexUnavailableError`, which is not caught in `book()`. It propagates to
the caller before `store.save` and before the `booking.confirmed` publish, so
no booking is made and the page and kiosk get an error. `cancel()` never
touches the search index, which is why cancellations kept working.

---

## Milestone 2: what a second delivery does

### Your prediction (before you run anything)

**What you expect `redeliver` on a refund message to do.**

I read `refundLedger.ts` and the `InMemoryBus` doc comment before running the
demo. `handle()` has no check for a message it has already seen, and the bus
keeps no record of what each subscriber has seen, so I expect `redeliver` to run
both steps again.

- **Ledger:** a second entry (`led-2`) for the same booking and the same $85.00.
- **Payment provider:** a second call to `refund` and a second settlement, so
  $170.00 returned for an $85.00 booking.
- **Bus log:** the delivery count for the refund message goes up by one per
  redelivery, so 3 after two redeliveries.

### Before your fix

**The run.**

```
booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3

=== after the cancellation (one delivery of the refund message) ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3

=== after one redelivery ===
ledger entries: 2
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-2 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 2
gateway settlements: 2
  stl-1 bk-1001 $85.00
  stl-2 bk-1001 $85.00
money returned in total: $170.00
dead letters: 0

redelivering msg-3 again

=== after two redeliveries ===
ledger entries: 3
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-2 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-3 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 3
gateway settlements: 3
  stl-1 bk-1001 $85.00
  stl-2 bk-1001 $85.00
  stl-3 bk-1001 $85.00
money returned in total: $255.00
dead letters: 0

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=3
```

**Your prediction against the run.**

They agree on all three: the ledger grew to 3 entries, the provider settled 3
times ($255.00 returned), and `msg-3` shows `deliveries=3`. The prediction did
not cover that nothing flags the duplicate: there are 0 dead letters and no
error, so the double payout is silent.

### Your fix

**The diff.**

```diff
diff --git a/src/handlers/refundLedger.ts b/src/handlers/refundLedger.ts
index 600ffca..ecbbfb4 100644
--- a/src/handlers/refundLedger.ts
+++ b/src/handlers/refundLedger.ts
@@ -25,22 +25,38 @@ export class RefundLedger implements Subscriber<RefundRequested> {
 
   private readonly entries: LedgerEntry[] = [];
   private readonly gateway: PaymentGateway;
+  /** Message ids whose ledger entry has been written. */
+  private readonly booked = new Set<string>();
+  /** Message ids whose refund the payment provider has accepted. */
+  private readonly paid = new Set<string>();
 
   constructor(gateway: PaymentGateway) {
     this.gateway = gateway;
   }
 
+  /**
+   * Safe to deliver more than once. The message id is the idempotency key, and
+   * the two steps are tracked separately: a delivery that wrote the ledger
+   * entry but died at the provider leaves the id in `booked` but not in
+   * `paid`, so a redelivery retries only the provider call.
+   */
   handle(message: Message<RefundRequested>): void {
     const event = message.payload;
-    this.entries.push({
-      entryId: `led-${this.entries.length + 1}`,
-      bookingId: event.bookingId,
-      organizer: event.organizer,
-      amountCents: event.amountCents,
-      reason: event.reason,
-      recordedAtMinute: message.publishedAtMinute,
-    });
-    this.gateway.refund(event.bookingId, event.amountCents);
+    if (!this.booked.has(message.id)) {
+      this.entries.push({
+        entryId: `led-${this.entries.length + 1}`,
+        bookingId: event.bookingId,
+        organizer: event.organizer,
+        amountCents: event.amountCents,
+        reason: event.reason,
+        recordedAtMinute: message.publishedAtMinute,
+      });
+      this.booked.add(message.id);
+    }
+    if (!this.paid.has(message.id)) {
+      this.gateway.refund(event.bookingId, event.amountCents);
+      this.paid.add(message.id);
+    }
   }
 
   /** Every ledger entry, oldest first. */
```

**What your fix uses to decide what to do on a second delivery, and what it
does not protect.** It uses the message id as an idempotency key, in two sets
(`booked` for the ledger entry, `paid` for the provider call). It does not
protect against two different refund messages for the same booking (different
ids), against a crash after the provider accepts the money but before `paid` is
updated (that retry would pay again; it needs an idempotency key at the provider),
or against a restart, since both sets are in memory.

### After your fix

**The run.**

```
booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3

=== after the cancellation (one delivery of the refund message) ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3

=== after one redelivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3 again

=== after two redeliveries ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=3
```

**What stays the same across its three states.** Ledger entries (1), gateway
calls (1), gateway settlements (1) and money returned ($85.00) are identical
after the cancellation, after one redelivery and after two. Only the bus log's
delivery count for `msg-3` moves (to 3).

---

## Milestone 3: a delivery that stops halfway

### The failure

**The run.**

```
armed: call 1 to the payment provider will throw
booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3
the cancel call itself returned: booking is cancelled

=== after the failed delivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 0
money returned in total: $0.00
dead letters: 1
  msg-3 refund.requested attempt 1 in RefundLedger: payment provider did not answer on call 1 for bk-1001
    failedAtMinute: 480
    payload: {"bookingId":"bk-1001","organizer":"H. Ahmad","organizerEmail":"hahmad@example.edu","amountCents":8500,"reason":"cancelled more than two hours ahead","requestedAtMinute":480}

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=1
```

### Your recovery

**What, if anything, the failed delivery left undone.** The ledger entry
`led-1` was written, but the provider call threw, so no money moved
(`gateway settlements: 0`, `$0.00` returned). The ledger says $85.00 was
refunded while the organizer has received nothing. The message is on the
dead-letter list.

**The option you took and its evidence.** I redelivered `msg-3` with
`app.bus.redeliver` (added at the end of `main()` in `src/demos/failureDemo.ts`).
The provider had healed, so this delivery paid. State after the redelivery:

```
=== after the redelivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 2
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 1
  msg-3 refund.requested attempt 1 in RefundLedger: payment provider did not answer on call 1 for bk-1001
    failedAtMinute: 480
    payload: {"bookingId":"bk-1001","organizer":"H. Ahmad","organizerEmail":"hahmad@example.edu","amountCents":8500,"reason":"cancelled more than two hours ahead","requestedAtMinute":480}
```

The bus log line for the refund message:

```
  msg-3 refund.requested deliveries=2
```

The ledger stays at 1 entry (no duplicate `led-2`) and the provider settled
exactly once. This is safe only because of the milestone 2 fix: the `booked` set
skips the ledger write and the empty `paid` set retries the provider call. The
dead-letter entry for attempt 1 is still on the list, since `redeliver` removes
nothing.

### The other option

**What the option you did not take would have cost.** Triage by hand would put
the work on a person, leave the organizer without their $85.00 until someone
reads the dead letter, and only be safe if that person first checks that the
ledger already has `led-1` and the provider has no settlement, so they do not
double-pay or double-book it.
