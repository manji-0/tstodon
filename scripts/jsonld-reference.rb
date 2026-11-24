# frozen_string_literal: true

# What Mastodon makes of JSON-LD: reads `{"documents": {name: document}}` on
# stdin and prints, as JSON:
#
# - `contexts`: each context Mastodon has preloaded and tstodon ships
#   (`CONTEXTS`), as Mastodon's JSON-LD processor holds it, under its URL
#   (`https://`; tstodon reads an `http://` URL as its `https://` one);
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
# this script fetches no context: the reference documents name only preloaded
# ones, and one that names another fails here. (Mastodon itself fetches it,
# and so does tstodon's forward check.) Run by
# scripts/generate-jsonld-reference.mjs inside the Mastodon image.
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

# Mastodon's own preloads (`config/initializers/json_ld_*.rb`), then those of
# the `json-ld-preloaded` gem its Gemfile requires, but three large ones a
# forward is not expected to name (`prefix.cc/context`, 138 KB;
# `linked.art`, 58 KB; `lov.linkeddata.es`, 37 KB), which tstodon fetches.
CONTEXTS = %w(
  https://www.w3.org/ns/activitystreams
  https://w3id.org/security/v1
  https://w3id.org/identity/v1
  https://www.w3.org/ns/cid/v1
  https://purl.archive.org/socialweb/webfinger
  https://w3id.org/security/data-integrity/v1
  https://w3id.org/security/data-integrity/v2
  https://www.w3.org/ns/did/v1
  https://w3id.org/security/suites/ed25519-2018/v1
  https://w3id.org/security/suites/ed25519-2020/v1
  https://w3id.org/security/suites/x25519-2020/v1
  https://w3id.org/security/suites/hmac-2019/v1
  https://w3id.org/security/suites/aes-2019/v1
  https://www.w3.org/2018/credentials/v1
  https://www.w3.org/ns/credentials/v2
  https://w3id.org/vc-revocation-list-2020/v1
  https://w3id.org/vaccination/v1
  https://w3id.org/age/v1
  https://w3id.org/cit/v1
  https://w3id.org/dcc/v1
  https://w3id.org/veres-one/v1
  https://w3id.org/webkms/v1
  https://w3id.org/zcap/v1
  https://w3id.org/openbadges/legacy-v1
  https://w3id.org/bundle/context
  https://schema.org
  http://schema.org/
  https://xmlns.com/foaf/context
  https://geojson.org/geojson-ld/geojson-context.jsonld
  https://www.w3.org/ns/oa
  https://www.w3.org/2013/json-ld-context/rdfa11
  https://iiif.io/api/image/2/context.json
  https://iiif.io/api/presentation/2/context.json
  https://pebbie.org/context/qb
  https://hub.culturegraph.org/entityfacts/context/v1/entityfacts.jsonld
  https://www.w3.org/ns/hydra/core
  https://www.w3.org/ns/csvw
  https://www.w3.org/2006/vcard/ns
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
  'contexts' => CONTEXTS.to_h { |url| [url.sub(%r{\Ahttp://}, 'https://'), JSON::LD::Context.new.parse(url).serialize] },
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
