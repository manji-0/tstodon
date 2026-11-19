# frozen_string_literal: true

# What Mastodon makes of an actor's key forms and of FEP-8b32 integrity
# proofs: reads `{"usernames": [...], "multikeys": {...}, "documents": {...},
# "proofs": {...}}` on stdin and prints, as JSON:
#
# - `usernames`: per username, whether `Account::USERNAME_ONLY_RE` (read from
#   the image's `account.rb`) matches it;
# - `multikeys`: per name, `Multibase.decode_key_to_pem` of the given
#   `publicKeyMultibase` (`type` and `pem`), or the class of the `error` it
#   raises; the `ed25519*` and `rsa*` names are added, made from keys made
#   for this run (`ed25519` is the key that makes the proofs);
# - `canonical`: per document, `to_json_c14n` (json-canonicalization), the
#   JCS form `eddsa-jcs-2022` hashes;
# - `proofs`: per case, the document with an `eddsa-jcs-2022` proof made with
#   this run's Ed25519 key, changed after signing as the case says, and
#   whether `ObjectIntegrityProof.verify_eddsa_jcs_2022` accepts it once
#   `signature` is left out, as `ProcessActivityService` checks a forward.
#
# Mastodon's code is loaded from the image, without Rails or a database. Run
# by scripts/generate-key-forms-reference.mjs inside the Mastodon image.
require 'base64'
require 'base58'
require 'digest'
require 'json'
require 'openssl'
require 'active_support/all'
require 'json/canonicalization'

module ActivityPub; end
module JsonLdHelper; end
load '/opt/mastodon/app/lib/multibase.rb'
load '/opt/mastodon/app/lib/activitypub/object_integrity_proof.rb'

username_source = File.read('/opt/mastodon/app/models/account.rb')[/^\s*USERNAME_RE\s*=\s*(.+)$/, 1]
USERNAME_RE = eval(username_source) # rubocop:disable Security/Eval
USERNAME_ONLY_RE = /\A#{USERNAME_RE}\z/i

def multicodec(code)
  bytes = []
  while code > 127
    bytes << ((code & 0x7F) | 128)
    code >>= 7
  end
  bytes << code
  bytes.pack('C*')
end

def base58(binary)
  "z#{Base58.binary_to_base58(binary, :bitcoin)}"
end

input = JSON.parse($stdin.read)
ed25519 = OpenSSL::PKey.generate_key('ED25519')
ed25519_raw = ed25519.raw_public_key
rsa = OpenSSL::PKey::RSA.new(2048)
rsa_pkcs1 = OpenSSL::ASN1::Sequence([OpenSSL::ASN1::Integer(rsa.n), OpenSSL::ASN1::Integer(rsa.e)]).to_der

multikeys = input.fetch('multikeys').merge(
  'ed25519' => base58(multicodec(0xED) + ed25519_raw),
  'ed25519Base64Url' => "u#{Base64.urlsafe_encode64(multicodec(0xED) + ed25519_raw, padding: false)}",
  'ed25519Short' => base58(multicodec(0xED) + ed25519_raw[0, 31]),
  'rsa' => base58(multicodec(0x1205) + rsa_pkcs1),
  'rsaSpki' => base58(multicodec(0x1205) + rsa.public_to_der)
)

verification_method = input.fetch('verificationMethod')

# An `eddsa-jcs-2022` proof as the Data Integrity spec makes one, with
# `proof_context` as the proof's `@context` when given.
def prove(document, key, verification_method, proof_context, value_base)
  proof = {
    'type' => 'DataIntegrityProof',
    'cryptosuite' => 'eddsa-jcs-2022',
    'verificationMethod' => verification_method,
    'proofPurpose' => 'assertionMethod',
    'created' => '2026-11-19T00:00:00Z',
  }
  proof['@context'] = proof_context unless proof_context.nil?
  unsecured = document.dup
  unsecured['@context'] = proof_context unless proof_context.nil?
  hash = Digest::SHA256.digest(proof.to_json_c14n) + Digest::SHA256.digest(unsecured.to_json_c14n)
  signature = key.sign(nil, hash)
  proof['proofValue'] = value_base == 'u' ? "u#{Base64.urlsafe_encode64(signature, padding: false)}" : base58(signature)
  document.merge('proof' => proof)
end

public_key = OpenSSL::PKey.read(ed25519.public_to_pem)

output = {
  'usernames' => input.fetch('usernames').to_h { |name| [name, USERNAME_ONLY_RE.match?(name)] },
  'multikeys' => multikeys.to_h do |name, value|
    type, pem = Multibase.decode_key_to_pem(value)
    [name, { 'multibase' => value, 'type' => type.to_s, 'pem' => pem }]
  rescue StandardError => e
    [name, { 'multibase' => value, 'error' => e.class.name }]
  end,
  'canonical' => input.fetch('documents').transform_values(&:to_json_c14n),
  'proofs' => input.fetch('proofs').transform_values do |spec|
    proved = prove(spec.fetch('document'), ed25519, verification_method, spec['proofContext'], spec['proofValueBase'])
    proved = proved.deep_merge(spec['after'] || {})
    proved['@context'] = spec['contextAfter'] if spec.key?('contextAfter')
    {
      'document' => proved,
      'verified' => ActivityPub::ObjectIntegrityProof.verify_eddsa_jcs_2022(proved.without('signature'), public_key) == true,
    }
  end,
}

puts JSON.generate(output)
