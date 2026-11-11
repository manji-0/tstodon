import { render, screen } from '@testing-library/react';

import { countableText } from '../../util/counter';
import { CharacterCounter } from '../character_counter';

describe('CharacterCounter', () => {
  it('counts what the server counts: a URL as 23, an emoji with a modifier as 1', () => {
    render(
      <CharacterCounter
        max={500}
        text={countableText(`👍🏽 https://example.com/${'a'.repeat(100)}`)}
      />,
    );
    expect(screen.getByText('475')).toBeDefined();
  });

  it('goes negative past the limit', () => {
    render(<CharacterCounter max={1} text='日本' />);
    expect(screen.getByText('-1')).toBeDefined();
  });
});
