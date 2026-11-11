import { useCallback, useEffect, useId } from 'react';

import { defineMessages, FormattedMessage } from 'react-intl';

import { expandAccountFeaturedTimeline } from '@/mastodon/actions/timelines';
import { Icon } from '@/mastodon/components/icon';
import { StatusQuoteManager } from '@/mastodon/components/status_quoted';
import { getTimelineItems } from '@/mastodon/models/timeline';
import {
  createAppSelector,
  useAppDispatch,
  useAppSelector,
} from '@/mastodon/store';
import PushPinIcon from '@/material-icons/400-24px/push_pin.svg?react';

import { Carousel } from './carousel';

const pinnedStatusesSelector = createAppSelector(
  [
    (state, accountId: string, tagged?: string) =>
      getTimelineItems(
        state.timelines.get(
          `account:${accountId}:pinned${tagged ? `:${tagged}` : ''}`,
        ),
      ),
  ],
  (items) =>
    items
      .toArray()
      .filter((id) => id !== null)
      .map((id) => ({ id })),
);

const messages = defineMessages({
  previous: { id: 'lightbox.previous', defaultMessage: 'Previous' },
  next: { id: 'lightbox.next', defaultMessage: 'Next' },
  current: {
    id: 'featured_carousel.current',
    defaultMessage: '<sr>Post</sr> {current, number} / {max, number}',
  },
  slide: {
    id: 'featured_carousel.slide',
    defaultMessage: 'Post {current, number} of {max, number}',
  },
});

export const FeaturedCarousel: React.FC<{
  accountId: string;
  tagged?: string;
}> = ({ accountId, tagged }) => {
  const accessibilityId = useId();

  // Load pinned statuses
  const dispatch = useAppDispatch();
  useEffect(() => {
    if (accountId) {
      void dispatch(expandAccountFeaturedTimeline(accountId, { tagged }));
    }
  }, [accountId, dispatch, tagged]);
  const pinnedStatuses = useAppSelector((state) =>
    pinnedStatusesSelector(state, accountId, tagged),
  );

  const renderSlide = useCallback(
    ({ id }: { id: string }) => (
      <StatusQuoteManager id={id} contextType='account' withCounters />
    ),
    [],
  );

  if (!accountId || pinnedStatuses.length === 0) {
    return null;
  }

  return (
    <Carousel
      items={pinnedStatuses}
      renderItem={renderSlide}
      aria-labelledby={`${accessibilityId}-title`}
      classNamePrefix='featured-carousel'
      messages={messages}
    >
      <h4 className='featured-carousel__title' id={`${accessibilityId}-title`}>
        <Icon id='thumb-tack' icon={PushPinIcon} />
        <FormattedMessage
          id='featured_carousel.header'
          defaultMessage='{count, plural, one {Pinned Post} other {Pinned Posts}}'
          values={{ count: pinnedStatuses.length }}
        />
      </h4>
    </Carousel>
  );
};
