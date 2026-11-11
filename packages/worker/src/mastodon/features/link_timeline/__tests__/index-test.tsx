import { IntlProvider } from 'react-intl';

import { MemoryRouter, Route } from 'react-router-dom';

import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import { statusFactoryAPI } from '@/testing/factories';
import { importStatus } from 'mastodon/actions/importer';
import { normalizeStatus } from 'mastodon/actions/importer/normalizer';
import { expandTimelineSuccess } from 'mastodon/actions/timelines';
import { rootReducer } from 'mastodon/reducers';
import type { RootState } from 'mastodon/store';
import { useAppSelector } from 'mastodon/store';

import LinkTimeline from '../index';

vi.mock('mastodon/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('mastodon/store')>()),
  useAppSelector: vi.fn(),
  useAppDispatch: () => vi.fn(),
}));

vi.mock('mastodon/features/ui/containers/status_list_container', () => ({
  default: () => null,
}));

const url = 'https://example.com/story';

describe('<LinkTimeline />', () => {
  it("titles the column with the card of the timeline's first status", () => {
    const status = normalizeStatus(
      statusFactoryAPI({
        id: '1',
        card: {
          url,
          title: 'A story',
          description: '',
          language: null,
          type: 'link',
          author_name: '',
          author_url: '',
          provider_name: '',
          provider_url: '',
          html: '',
          width: 0,
          height: 0,
          image: null,
          image_description: '',
          embed_url: '',
          blurhash: null,
          published_at: null,
          authors: [],
        },
      }),
      undefined,
      {},
    );
    const state = [
      importStatus(status),
      expandTimelineSuccess(
        `link:${url}`,
        [statusFactoryAPI({ id: '1' })],
        null,
        false,
        false,
        false,
        false,
      ),
    ].reduce(rootReducer, rootReducer(undefined, { type: 'INIT' }));
    vi.mocked(useAppSelector).mockImplementation(
      (selector: (state: RootState) => unknown) => selector(state),
    );

    render(
      <MemoryRouter initialEntries={[`/links/${encodeURIComponent(url)}`]}>
        <IntlProvider locale='en' messages={{}}>
          <Route path='/links/:url'>
            <LinkTimeline multiColumn={false} />
          </Route>
        </IntlProvider>
      </MemoryRouter>,
    );

    // It read `.title` off the card, an Immutable Map: always `undefined`.
    expect(screen.getAllByText('A story')).not.toHaveLength(0);
  });
});
