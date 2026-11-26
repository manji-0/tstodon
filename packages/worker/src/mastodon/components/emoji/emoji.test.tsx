import { customEmojiFactory } from '@/testing/factories';
import { fireEvent, render, screen } from '@/testing/rendering';

import { AnimateEmojiContext, CustomEmojiProvider } from './context';

import { Emoji } from './index';

vi.mock('@/mastodon/features/emoji/mode', () => ({
  useEmojiAppState: () => ({
    currentLocale: 'en',
    mode: 'twemoji',
    darkTheme: false,
    assetHost: '',
  }),
}));

const renderAnimated = () =>
  render(
    <CustomEmojiProvider
      emojis={[
        customEmojiFactory({
          url: '/custom-emoji/animated.gif',
          static_url: '/custom-emoji/static.png',
        }),
      ]}
    >
      <AnimateEmojiContext.Provider value>
        <Emoji code=':custom:' />
      </AnimateEmojiContext.Provider>
    </CustomEmojiProvider>,
  );

describe('<Emoji /> with a custom emoji', () => {
  it('shows the animated image while animating', () => {
    renderAnimated();

    expect(screen.getByAltText(':custom:').getAttribute('src')).toBe(
      '/custom-emoji/animated.gif',
    );
  });

  it('falls back to the static image when the animated one fails to load', () => {
    renderAnimated();

    fireEvent.error(screen.getByAltText(':custom:'));

    expect(screen.getByAltText(':custom:').getAttribute('src')).toBe(
      '/custom-emoji/static.png',
    );
  });
});
