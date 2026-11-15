# frozen_string_literal: true

# Loaded by Mastodon as an initializer (compose.yaml). Mastodon's `Follow`
# handler checks `delete_arrived_first?` and stores the follow some
# milliseconds later. An `Undo` handled in between finds no follow, so the
# follow stays. This holds the handler after that check for
# INTEROP_FOLLOW_HOLD_MS, so an `Undo` sent right after a `Follow` is always
# handled in between. See README.md.
hold_ms = ENV.fetch('INTEROP_FOLLOW_HOLD_MS', '0').to_i

if hold_ms.positive?
  Rails.application.config.to_prepare do
    ActivityPub::Activity::Follow.prepend(
      Module.new do
        define_method(:delete_arrived_first?) do |uri|
          super(uri).tap { sleep(hold_ms / 1000.0) }
        end
      end
    )
  end
end
