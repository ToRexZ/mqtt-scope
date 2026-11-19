# Repeat publish

Small change. Requested by a user (San, 13 Nov): "manglede virkelig i mqtt
explorer at man kunne toggle at sende continues beskeder så man ikke bare
sendte en gang."

## Why

Testing a robot often needs a message sent over and over: a heartbeat or
watchdog that must keep arriving, or a command a node only acts on while it
keeps coming. Today each click of **Publish** sends once.

## Goals

1. **Repeat toggle** in the publisher's top row, next to **Publish**:
   ```
   [topic…………]  QoS 0 ▾  ☐ Retain  ☐ Repeat at [ 1 Hz ▾ ]   [ Publish ]
   ```
   - With Repeat ticked, **Publish** reads **Start**. Start sends the message
     at once and then at the chosen rate until stopped; the button then reads
     **Stop** (highlighted) and shows how many were sent, e.g. `Stop (42)`.
   - Rate in Hz (maintainer, 19 Nov: "make it Hz, selectable", "also allow to
     type the number in"): a field you type a rate into, with a dropdown of
     0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100 Hz; default 1 Hz. Any rate from
     0.01 to 100 Hz (decimals allowed); outside that, or not a number, the
     field is marked and Start is disabled. Changing it while running applies
     from the next message.
2. **What is sent** is the message as it was at Start (topic, payload, format,
   QoS, retain). Editing while it runs doesn't change what is sent; a note under
   the row says "Sending the message as it was at Start — Stop and Start again
   to send your changes" while the editor differs from it.
3. **It stops** on Stop, when the connection drops or is closed, when its tab
   or window closes or reloads, and on a failed publish (one error toast, then
   stopped). Unticking Repeat while running stops it too.
4. **Checks happen once**, at Start: the retained-message confirmation, JSON
   validation, and the message goes into Recent once. No "Published to …" toast
   per message.
5. The **Publish shortcut** starts and stops it the same way as the button.
6. The Repeat setting and rate are remembered per connection tab like the
   rest of the publisher; a running repeat is never restored after a restart.

## Non-goals

- No changing payloads (counters, timestamps, random values).
- No schedules beyond a fixed interval; no several repeats at once per tab.
- No repeat for Saved/Recent list items directly (load one, then Start).

## Approaches considered

- **Snapshot at Start (chosen).** A half-typed JSON edit can't break a running
  heartbeat; what is sent is always what was checked.
- *Send the editor's current content each time.* Handy for tweaking a value
  live, but an invalid edit would have to skip or stop sends mid-test.
- *Repeat button on Saved/Recent items.* More places to stop things from; can
  come later.

## Testing

- Unit: rate list and saved-rate validation; the repeat loop (start, count, stop, stop on
  failure) with a fake clock and a fake publish.
- E2E: Start at 10 Hz → the broker receives several identical messages and
  the button counts them; Stop → no more arrive; editing while running sends
  the old payload and shows the note; disconnect stops it; retained asks once;
  the shortcut toggles; Repeat and rate are kept after a restart, not
  running.
