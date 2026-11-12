import { urlRegex } from '../url_regex';

describe('urlRegex', () => {
  it('takes the URLs out of text for language detection, with the character before each', () => {
    expect(
      'lire https://例え.jp/パス et gemini://example.com/a puis example.com'.replace(urlRegex, ''),
    ).toBe('lire et puis example.com');
  });
});
