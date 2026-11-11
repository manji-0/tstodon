import { useEffect } from 'react';

import { FormattedMessage } from 'react-intl';

import { Link } from 'react-router-dom';

import { fetchTrendingHashtags } from 'mastodon/actions/trends';
import { ImmutableHashtag as Hashtag } from 'mastodon/components/hashtag';
import { showTrends } from 'mastodon/initial_state';
import { useAppSelector, useAppDispatch } from 'mastodon/store';

export const Trends: React.FC = () => {
  const dispatch = useAppDispatch();
  const trends = useAppSelector((state) =>
    state.trends.get('tags').get('items'),
  );

  useEffect(() => {
    dispatch(fetchTrendingHashtags());

    const refreshInterval = setInterval(() => {
      dispatch(fetchTrendingHashtags());
    }, 900 * 1000);

    return () => {
      clearInterval(refreshInterval);
    };
  }, [dispatch]);

  if (!showTrends || trends.isEmpty()) {
    return null;
  }

  return (
    <aside className='navigation-panel__portal'>
      <div className='getting-started__trends'>
        <h2 className='getting-started__trends-heading'>
          <Link to={'/explore/tags'}>
            <FormattedMessage
              id='trends.trending_now'
              defaultMessage='Trending now'
            />
          </Link>
        </h2>

        {trends.take(4).map((hashtag) => (
          <Hashtag key={hashtag.get('name') as string} hashtag={hashtag} />
        ))}
      </div>
    </aside>
  );
};
