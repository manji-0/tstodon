# frozen_string_literal: true

# What Mastodon makes of JSON-LD: reads `{"documents": {name: document}}` on
# stdin and prints, as JSON:
#
# - `contexts`: each context Mastodon has preloaded and tstodon ships
#   (`CONTEXTS`), as Mastodon's JSON-LD processor holds it, under its URL;
# - `fullContext`: `ContextHelper#full_context`, the context Mastodon compacts
#   a signed activity to before it reads it;
# - `canonical`: per document, `JsonLdHelper#canonicalize` (URDNA2015 N-Quads);
# - `signed`: per document, `ActivityPub::LinkedDataSignature#sign!` with a key
#   made for this run, whose public half is `publicKeyPem`;
# - `forwarded`: per signed document, the copy Mastodon forwards: compacted
#   to `full_context` and patched (`patch_for_forwarding!`), or `null` when
#   `safe_for_forwarding?` says Mastodon would not forward it;
# - `own`: for each of tstodon's signed activities in `own.signed`, what
#   Mastodon makes of it. `read` is the body compacted to `full_context`, the
#   form `ProcessActivityService` works with (without `@context` and
#   `signature`); `forwarded` is as above; `verified` says whether
#   `LinkedDataSignature#verify_actor!` accepts the signature, with
#   `own.publicKeyPem` as the key `own.keyId` names.
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

# `Keypair.from_keyid` without a database: only the key `own.keyId` names.
class Keypair
  Found = Struct.new(:keypair, :actor) do
    def public_key = keypair.public_key
    def usable? = true
    def type = 'rsa'
  end

  class << self
    attr_accessor :known

    def from_keyid(uri) = known&.fetch(uri, nil)
  end
end

input = JSON.parse($stdin.read)
helper = Object.new.extend(JsonLdHelper)
key = OpenSSL::PKey::RSA.new(2048)
signer = KeyHolder.new(input.fetch('keyId'), key)

output = {
  'contexts' => CONTEXTS.to_h { |url| [url, JSON::LD::Context.new.parse(url).serialize] },
  'fullContext' => helper.full_context,
  'publicKeyPem' => key.public_key.to_pem,
  'canonical' => {},
  'signed' => {},
  'forwarded' => {},
  'own' => {},
}

input.fetch('documents').each do |name, document|
  output['canonical'][name] = helper.canonicalize(document)
  signed = ActivityPub::LinkedDataSignature.new(document).sign!(nil, sign_with: signer)
  output['signed'][name] = signed
  # What Mastodon forwards of it (`ProcessActivityService`): compacted to
  # its full context, patched, and only when that is safe; else nil.
  original = JSON.parse(JSON.generate(signed))
  compacted = helper.compact(original)
  helper.patch_for_forwarding!(original, compacted)
  output['forwarded'][name] = helper.safe_for_forwarding?(original, compacted) ? compacted : nil
end

own = input.fetch('own')
Keypair.known = {
  own.fetch('keyId') => Keypair::Found.new(OpenSSL::PKey::RSA.new(own.fetch('publicKeyPem')), :verified),
}
own.fetch('signed').each do |name, signed|
  original = JSON.parse(JSON.generate(signed))
  compacted = helper.compact(original)
  verified = ActivityPub::LinkedDataSignature.new(compacted).verify_actor! == :verified
  read = compacted.without('@context', 'signature')
  helper.patch_for_forwarding!(original, compacted)
  output['own'][name] = {
    'read' => read,
    'forwarded' => helper.safe_for_forwarding?(original, compacted) ? compacted : nil,
    'verified' => verified,
  }
end

puts JSON.generate(output)
