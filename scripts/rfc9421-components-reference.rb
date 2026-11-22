# frozen_string_literal: true

# What Mastodon's `linzer` 0.8.0 makes of RFC 9421 covered components,
# parameters included: reads `{"cases": [...], "multipleSignatures": {...}}`
# on stdin, each case `{name, method, url, headers, signatureInput}`
# (`headers` maps a name to a value, or to a list of values sent on separate
# lines), and prints, as JSON, per case:
#
# - `base`: the signature base `Linzer.verify` checks, built as
#   `Linzer::Verifier` builds it (`validate_components`, then
#   `Common.signature_base`), on a `Rack::Request` whose header values are
#   UTF-8 strings (`Rack::MockRequest`); or `null` when `linzer` refuses the
#   components (a `Linzer::Error`: missing, invalid or repeated);
# - `raises`: the class of any other error, which Mastodon does not rescue
#   (a 500), in place of `base`;
# - `pumaBase`: the same, on header values and a query string that are
#   binary (ASCII-8BIT) strings, as Puma's parser hands them to Rack;
# - `signature`: the base signed with RFC 9421's test-key-rsa
#   (`rsa-v1_5-sha256`, B.1.1), when there is a base.
#
# and `multipleSignatures`: the error `Linzer::Signature.build` raises for
# the given `Signature-Input` and `Signature` (Mastodon passes no label).
#
# Run by scripts/generate-rfc9421-components-reference.mjs, inside the
# Mastodon image or with the gems on `RUBYLIB`.
require 'json'
require 'openssl'
require 'rack'
require 'linzer'
require 'linzer/rack'

RSA_PEM = <<~PEM
  -----BEGIN RSA PRIVATE KEY-----
  MIIEqAIBAAKCAQEAhAKYdtoeoy8zcAcR874L8cnZxKzAGwd7v36APp7Pv6Q2jdsP
  BRrwWEBnez6d0UDKDwGbc6nxfEXAy5mbhgajzrw3MOEt8uA5txSKobBpKDeBLOsd
  JKFqMGmXCQvEG7YemcxDTRPxAleIAgYYRjTSd/QBwVW9OwNFhekro3RtlinV0a75
  jfZgkne/YiktSvLG34lw2zqXBDTC5NHROUqGTlML4PlNZS5Ri2U4aCNx2rUPRcKI
  lE0PuKxI4T+HIaFpv8+rdV6eUgOrB2xeI1dSFFn/nnv5OoZJEIB+VmuKn3DCUcCZ
  SFlQPSXSfBDiUGhwOw76WuSSsf1D4b/vLoJ10wIDAQABAoIBAG/JZuSWdoVHbi56
  vjgCgkjg3lkO1KrO3nrdm6nrgA9P9qaPjxuKoWaKO1cBQlE1pSWp/cKncYgD5WxE
  CpAnRUXG2pG4zdkzCYzAh1i+c34L6oZoHsirK6oNcEnHveydfzJL5934egm6p8DW
  +m1RQ70yUt4uRc0YSor+q1LGJvGQHReF0WmJBZHrhz5e63Pq7lE0gIwuBqL8SMaA
  yRXtK+JGxZpImTq+NHvEWWCu09SCq0r838ceQI55SvzmTkwqtC+8AT2zFviMZkKR
  Qo6SPsrqItxZWRty2izawTF0Bf5S2VAx7O+6t3wBsQ1sLptoSgX3QblELY5asI0J
  YFz7LJECgYkAsqeUJmqXE3LP8tYoIjMIAKiTm9o6psPlc8CrLI9CH0UbuaA2JCOM
  cCNq8SyYbTqgnWlB9ZfcAm/cFpA8tYci9m5vYK8HNxQr+8FS3Qo8N9RJ8d0U5Csw
  DzMYfRghAfUGwmlWj5hp1pQzAuhwbOXFtxKHVsMPhz1IBtF9Y8jvgqgYHLbmyiu1
  mwJ5AL0pYF0G7x81prlARURwHo0Yf52kEw1dxpx+JXER7hQRWQki5/NsUEtv+8RT
  qn2m6qte5DXLyn83b1qRscSdnCCwKtKWUug5q2ZbwVOCJCtmRwmnP131lWRYfj67
  B/xJ1ZA6X3GEf4sNReNAtaucPEelgR2nsN0gKQKBiGoqHWbK1qYvBxX2X3kbPDkv
  9C+celgZd2PW7aGYLCHq7nPbmfDV0yHcWjOhXZ8jRMjmANVR/eLQ2EfsRLdW69bn
  f3ZD7JS1fwGnO3exGmHO3HZG+6AvberKYVYNHahNFEw5TsAcQWDLRpkGybBcxqZo
  81YCqlqidwfeO5YtlO7etx1xLyqa2NsCeG9A86UjG+aeNnXEIDk1PDK+EuiThIUa
  /2IxKzJKWl1BKr2d4xAfR0ZnEYuRrbeDQYgTImOlfW6/GuYIxKYgEKCFHFqJATAG
  IxHrq1PDOiSwXd2GmVVYyEmhZnbcp8CxaEMQoevxAta0ssMK3w6UsDtvUvYvF22m
  qQKBiD5GwESzsFPy3Ga0MvZpn3D6EJQLgsnrtUPZx+z2Ep2x0xc5orneB5fGyF1P
  WtP+fG5Q6Dpdz3LRfm+KwBCWFKQjg7uTxcjerhBWEYPmEMKYwTJF5PBG9/ddvHLQ
  EQeNC8fHGg4UXU8mhHnSBt3EA10qQJfRDs15M38eG2cYwB1PZpDHScDnDA0=
  -----END RSA PRIVATE KEY-----
PEM

def rack_request(test_case, binary:)
  # The query string as sent: `env_for` parses the URL and refuses a bad escape.
  url, query = test_case['url'].split('?', 2)
  env = Rack::MockRequest.env_for(url, method: test_case['method'])
  env['QUERY_STRING'] = query.to_s
  test_case['headers'].each do |name, value|
    plain = %w(content-type content-length).include?(name.downcase)
    joined = Array(value).join(', ')
    env[plain ? name.upcase.tr('-', '_') : "HTTP_#{name.upcase.tr('-', '_')}"] = binary ? joined.b : joined
  end
  if binary
    env['QUERY_STRING'] = env['QUERY_STRING'].b
    env['REQUEST_METHOD'] = env['REQUEST_METHOD'].b
  end
  Rack::Request.new(env)
end

def signature_base(test_case, binary:)
  signature = Linzer::Signature.build({
    'signature-input' => "sig1=#{test_case['signatureInput']}",
    'signature' => 'sig1=:AA==:',
  })
  message = Linzer::Message.new(rack_request(test_case, binary:))
  Linzer::Verifier.send(:validate_components, message, signature.serialized_components, field_ids: signature.field_ids)
  { base: Linzer::Common.signature_base(message, signature.serialized_components, signature.parameters, field_ids: signature.field_ids) }
rescue Linzer::Error
  { base: nil }
rescue StandardError => e
  { raises: e.class.name }
end

input = JSON.parse($stdin.read)
key = Linzer.new_rsa_v1_5_sha256_key(RSA_PEM, 'test-key-rsa')

cases = input['cases'].map do |test_case|
  utf8 = signature_base(test_case, binary: false)
  puma = signature_base(test_case, binary: true)
  out = { name: test_case['name'] }
  out.merge!(utf8)
  out[:pumaBase] = puma[:base] if puma.key?(:base) && puma[:base] != utf8[:base]
  out[:pumaRaises] = puma[:raises] if puma[:raises] != utf8[:raises]
  out[:signature] = [key.sign(utf8[:base].b)].pack('m0') if utf8[:base]
  out
end

multiple = input['multipleSignatures']
multiple_error =
  begin
    Linzer::Signature.build({ 'signature-input' => multiple['signatureInput'], 'signature' => multiple['signature'] })
    nil
  rescue StandardError => e
    "#{e.class.name}: #{e.message}"
  end

puts JSON.pretty_generate({ cases:, multipleSignatures: multiple_error })
