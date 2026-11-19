# frozen_string_literal: true

# What Mastodon makes of JSON-LD: reads `{"documents": {name: document}}` on
# stdin and prints, as JSON:
#
# - `contexts`: each context Mastodon has preloaded and tstodon ships
#   (`CONTEXTS`), as Mastodon's JSON-LD processor holds it, under its URL;
# - `canonical`: per document, `JsonLdHelper#canonicalize` (URDNA2015 N-Quads);
# - `signed`: per document, `ActivityPub::LinkedDataSignature#sign!` with a key
#   made for this run, whose public half is `publicKeyPem`.
#
# Mastodon's code is loaded from the image, without Rails or a database, and
# no context is ever fetched: a document that names another one fails, as it
# fails in tstodon. Run by scripts/generate-jsonld-reference.mjs inside the
# Mastodon image.
require 'base64'
require 'json'
require 'active_support/all'
require 'json/ld'
require 'json/ld/preloaded'
require 'rdf/normalize'
Dir['/opt/mastodon/config/initializers/json_ld_*.rb'].each { |file| require file }

module ActivityPub; end
load '/opt/mastodon/app/helpers/context_helper.rb'
load '/opt/mastodon/app/helpers/json_ld_helper.rb'
load '/opt/mastodon/app/lib/activitypub/linked_data_signature.rb'

module JsonLdHelper
  def load_jsonld_context(url, _options = {}, &_block)
    raise JSON::LD::JsonLdError::LoadingDocumentFailed, "not preloaded: #{url}"
  end
end

CONTEXTS = %w(
  https://www.w3.org/ns/activitystreams
  https://w3id.org/security/v1
  https://w3id.org/identity/v1
  https://www.w3.org/ns/cid/v1
  https://purl.archive.org/socialweb/webfinger
).freeze

KeyHolder = Struct.new(:full_uri, :keypair)

input = JSON.parse($stdin.read)
helper = Object.new.extend(JsonLdHelper)
key = OpenSSL::PKey::RSA.new(2048)
signer = KeyHolder.new(input.fetch('keyId'), key)

output = {
  'contexts' => CONTEXTS.to_h { |url| [url, JSON::LD::Context.new.parse(url).serialize] },
  'publicKeyPem' => key.public_key.to_pem,
  'canonical' => {},
  'signed' => {},
}

input.fetch('documents').each do |name, document|
  output['canonical'][name] = helper.canonicalize(document)
  output['signed'][name] = ActivityPub::LinkedDataSignature.new(document).sign!(nil, sign_with: signer)
end

puts JSON.generate(output)
