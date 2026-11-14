-- A note that a `QuoteRequest` stores is streamed as new by the `Create` that
-- delivers it, not by the `QuoteRequest`. The `QuoteRequest` wrote a `Created`
-- marker (`remote_status_owed`, migration 0140), ran the late steps and
-- deleted it, so the `Create` that came after found nothing owed and the note
-- was never streamed.
-- `stream_only` is 1 on a `Created` marker whose every late step has run but
-- the `update` stream event: a `QuoteRequest` leaves it so, and the `Create`
-- sends the event and deletes the marker. A note no `Create` ever delivers
-- keeps the marker until the sweep, which does not count it as abandoned
-- work: nothing but a stream event to nobody was left undone.
ALTER TABLE remote_status_owed
  ADD COLUMN stream_only INTEGER NOT NULL DEFAULT 0 CHECK (stream_only IN (0, 1));
