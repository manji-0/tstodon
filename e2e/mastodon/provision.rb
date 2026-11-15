# frozen_string_literal: true

# Run by bootstrap.sh inside the Mastodon container (`rails runner`), and by
# the sweep for the users one run needs. Creates each named user as
# `tootctl accounts create --confirmed --approve` does, and an OAuth token for
# it. Prints one `PROVISIONED username token` line per user.
# Safe to rerun: an existing user gets a new token.

# `moderator` is the instance's Owner, and its token reads the admin API.
ADMINS = %w(moderator).freeze
USER_SCOPES = 'read write follow push'
ADMIN_SCOPES = "#{USER_SCOPES} admin:read admin:write".freeze

app = Doorkeeper::Application.find_or_create_by!(name: 'tstodon interop e2e') do |a|
  a.redirect_uri = 'urn:ietf:wg:oauth:2.0:oob'
  a.scopes = ADMIN_SCOPES
end
app.update!(scopes: ADMIN_SCOPES) unless app.scopes.to_s == ADMIN_SCOPES

# `:interop:`, for the custom emoji scenario.
unless CustomEmoji.local.exists?(shortcode: 'interop')
  File.open(Rails.public_path.join('badge.png')) do |image|
    CustomEmoji.create!(shortcode: 'interop', image: image)
  end
end

ARGV.each do |username|
  account = Account.find_local(username)
  if account.nil?
    user = User.new(
      email: "#{username}@mastodon.test",
      password: SecureRandom.hex,
      agreement: true,
      confirmed_at: Time.now.utc,
      bypass_registration_checks: true,
      account: Account.new(username: username)
    )
    user.save!
    user.approve!
    account = user.account
  end
  admin = ADMINS.include?(username)
  account.user.update!(role: UserRole.find_by!(name: 'Owner')) if admin
  token = Doorkeeper::AccessToken.create!(
    application: app,
    resource_owner_id: account.user.id,
    scopes: admin ? ADMIN_SCOPES : USER_SCOPES
  )
  puts "PROVISIONED #{username} #{token.token}"
end
