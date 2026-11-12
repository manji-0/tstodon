import { render, screen } from '@testing-library/react';

import { countableText, graphemeLength } from '../../util/counter';
import { CharacterCounter } from '../character_counter';

describe('CharacterCounter', () => {
  it('counts what the server counts: a URL as 23, an emoji with a modifier as 1', () => {
    render(
      <CharacterCounter
        max={500}
        text={countableText(`👍🏽 https://example.com/${'a'.repeat(100)}`)}
        length={graphemeLength}
      />,
    );
    expect(screen.getByText('475')).toBeDefined();
  });

  it("counts a URL as Mastodon's server finds it, where twitter-text ends it early or finds none", () => {
    render(
      <CharacterCounter
        max={500}
        text={countableText('https://例え.jp/パス gemini://example.com/capsule')}
        length={graphemeLength}
      />,
    );
    expect(screen.getByText('453')).toBeDefined();
  });

  it('counts with stringz unless given a length, as the alt text modal does', () => {
    render(<CharacterCounter max={1} text='कि' />);
    expect(screen.getByText('-1')).toBeDefined();
  });

  it('goes negative past the limit', () => {
    render(<CharacterCounter max={1} text='日本' />);
    expect(screen.getByText('-1')).toBeDefined();
  });
});
