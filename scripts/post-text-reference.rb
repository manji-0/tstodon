# frozen_string_literal: true

# What Mastodon's server finds in post text: reads `{"texts": […], "domains": […]}`
# on stdin and prints the same keys. Per text, `[entities, countableText, length]`,
# where an entity is `[kind, start, end]` (`U`rl, `H`ashtag or `M`ention,
# UTF-16 indices) from `Extractor.extract_entities_with_indices`, as
# `TextFormatter` links them, and the text and its length are
# `StatusLengthValidator`'s `countable_text` and `countable_length`. Per
# domain, what libidn's `IDN::Idna.toASCII` makes of it, which twitter-text
# asks for a URL's host, or `null` where it raises.
#
# Run by scripts/generate-post-text-fixture.mjs. It needs Ruby 3, the gems
# `twitter-text` 3.1.0 and `idn-ruby` (libidn), and MASTODON_SRC, a checkout
# of Mastodon at the release packages/worker/src/UPSTREAM.md records.
require "English"
require "json"
require "twitter-text"
require "idn"

Encoding.default_external = Encoding::UTF_8
src = ENV.fetch("MASTODON_SRC")

# Rails' `blank?` and `present?`, which the files below call on strings.
class Object
  def blank? = respond_to?(:empty?) ? empty? : !self
  def present? = !blank?
end

class String
  def blank? = match?(/\A[[:space:]]*\z/)
end

module ActiveModel
  class Validator; end
end

# The patterns of `Account` and `Tag`, which are ActiveRecord models: their
# constant lines, evaluated in a bare module.
def model_constants(file, names)
  File.readlines(File.join(ENV.fetch("MASTODON_SRC"), file)).grep(/\A\s*(?:#{names})\s*=/).join
end

module Account
  class_eval(model_constants("app/models/account.rb", "USERNAME_RE|MENTION_RE"))
end

module Tag
  class_eval(model_constants("app/models/tag.rb", "HASHTAG_[A-Z_]+"))
end

load File.join(src, "config/initializers/twitter_regex.rb")
load File.join(src, "app/lib/extractor.rb")
load File.join(src, "app/validators/status_length_validator.rb")

def utf16(text, index)
  text[0...index].encode("UTF-16LE").bytesize / 2
end

KINDS = { url: "U", hashtag: "H", screen_name: "M" }.freeze
validator = StatusLengthValidator.new

input = JSON.parse($stdin.read)

texts = input.fetch("texts").map do |text|
  entities = Extractor.extract_entities_with_indices(text, extract_url_without_protocol: false).map do |entity|
    kind = KINDS.fetch(KINDS.keys.find { |key| entity.key?(key) })
    [kind, *entity[:indices].map { |index| utf16(text, index) }]
  end
  countable = validator.send(:countable_text, text)
  [entities, countable, validator.send(:countable_length, countable)]
end

domains = input.fetch("domains").map do |domain|
  IDN::Idna.toASCII(domain)
rescue IDN::Idna::IdnaError
  nil
end

puts JSON.generate({ texts: texts, domains: domains })
