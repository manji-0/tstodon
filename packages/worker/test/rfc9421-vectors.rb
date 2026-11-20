# Prints the RFC 9421 vectors in `server/http-message-signature.test.ts`,
# made and checked the way Mastodon v4.7.5 makes and checks them: `Request`
# double-knocks with `linzer` (label `sig1`, `@method`, `@target-uri`, and
# `content-digest` on a POST, with `created` and `keyid`), and
# `SignedRequest::HttpMessageSignature` verifies with `Linzer.verify` (on the
# Rack request, the adapter `config/initializers/linzer.rb` loads). The
# keys are RFC 9421's test-key-rsa (B.1.1) and test-key-ed25519 (B.1.4), so
# each signature is deterministic.
#
# Run it with Mastodon's `linzer` 0.8.0, `starry` and `rack` on the load path,
# for example inside the e2e stack's web container:
#   docker compose exec -T web bundle exec ruby - < packages/worker/test/rfc9421-vectors.rb
require "rack"
require "linzer"
require "linzer/rack"
require "json"
require "openssl"
require "time"

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

ED25519_PEM = <<~PEM
  -----BEGIN PRIVATE KEY-----
  MC4CAQAwBQYDK2VwBCIEIJ+DYvh6SEqVTm50DFtMDoQikTmiCqirVv9mWG9qfSnF
  -----END PRIVATE KEY-----
PEM

CREATED = 1_767_225_600 # 2026-01-01T00:00:00Z

def rack_request(method, url, headers, body)
  env = Rack::MockRequest.env_for(url, method: method, input: body || "")
  headers.each do |name, value|
    plain = %w(content-type content-length).include?(name.downcase)
    env[plain ? name.upcase.tr("-", "_") : "HTTP_#{name.upcase.tr('-', '_')}"] = value
  end
  Rack::Request.new(env)
end

def vector(name, kind, method, url, body, key_id)
  pem = kind == :rsa ? RSA_PEM : ED25519_PEM
  headers = { "Host" => URI(url).host, "Date" => Time.at(CREATED).utc.httpdate }
  headers["content-digest"] = "sha-256=:#{OpenSSL::Digest.base64digest('sha256', body)}:" if body
  components = body ? %w(@method @target-uri content-digest) : %w(@method @target-uri)
  key = kind == :rsa ? Linzer.new_rsa_v1_5_sha256_key(pem, key_id) : Linzer.new_ed25519_key(pem, key_id)
  sent = rack_request(method, url, headers, body)
  signed = headers.merge(Linzer.sign(key, Linzer::Message.new(sent), components, created: CREATED).to_h)

  received = Linzer::Message.new(rack_request(method, url, signed, body))
  signature = Linzer::Signature.build({ "signature-input" => signed["signature-input"], "signature" => signed["signature"] })
  public_pem = OpenSSL::PKey.read(pem).public_to_pem
  public_key = kind == :rsa ? Linzer.new_rsa_v1_5_sha256_public_key(public_pem) : Linzer.new_ed25519_public_key(public_pem)
  {
    name: name,
    method: method,
    url: url,
    body: body,
    headers: signed,
    signatureBase: Linzer.signature_base(received, signature.serialized_components, signature.parameters),
    verified: Linzer.verify(public_key, received, signature),
  }
end

puts JSON.pretty_generate([
  vector("rsa POST", :rsa, "POST", "https://tstodon.example/inbox", '{"type":"Follow"}', "https://mastodon.example/users/alice#main-key"),
  vector("rsa GET", :rsa, "GET", "https://tstodon.example/users/bob/outbox?page=true", nil, "https://mastodon.example/actor#main-key"),
  vector("ed25519 POST", :ed25519, "POST", "https://tstodon.example/users/bob/inbox", '{"type":"Like"}', "https://mastodon.example/users/alice#ed25519-key"),
])
