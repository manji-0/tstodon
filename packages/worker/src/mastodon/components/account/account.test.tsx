import { Map as ImmutableMap } from 'immutable';

import { accountFactoryImmutable } from '@/testing/factories';
import { render } from '@/testing/rendering';
import type { RootState } from 'mastodon/store';
import { useAppSelector } from 'mastodon/store';

import { Account } from './index';

vi.mock('mastodon/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('mastodon/store')>()),
  useAppSelector: vi.fn(),
  useAppDispatch: () => vi.fn(),
}));

const verifiedValue =
  '<a href="https://example.com/me" target="_blank" rel="nofollow noopener me" translate="no"><span class="invisible">https://</span><span class="">example.com/me</span><span class="invisible"></span></a>';

describe('<Account /> with a verified field', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const account = accountFactoryImmutable({
      id: '1',
      fields: [
        {
          name: 'Website',
          value: verifiedValue,
          verified_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    vi.mocked(useAppSelector).mockImplementation(
      (selector: (state: RootState) => unknown) =>
        selector({
          accounts: ImmutableMap([['1', account]]),
          relationships: ImmutableMap(),
        } as unknown as RootState),
    );
  });

  it('shows the verified link as text inside the account link', () => {
    const { container } = render(<Account id='1' withMenu={false} />);

    const accountLink = container.querySelector('a.account__display-name');
    expect(accountLink?.textContent).toContain('example.com/me');
    expect(accountLink?.textContent).not.toContain('https://');
    expect(accountLink?.querySelector('a')).toBeNull();
  });
});
