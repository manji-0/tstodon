import { useRef, useEffect, useCallback } from 'react';

import { useParams } from 'react-router-dom';

import { Helmet } from '@unhead/react/helmet';

import TrendingUpIcon from '@/material-icons/400-24px/trending_up.svg?react';
import { expandLinkTimeline } from 'mastodon/actions/timelines';
import { Column } from 'mastodon/components/column';
import type { ColumnRef } from 'mastodon/components/column';
import { ColumnHeader } from 'mastodon/components/column_header';
import StatusListContainer from 'mastodon/features/ui/containers/status_list_container';
import { useAppDispatch, useAppSelector } from 'mastodon/store';

export const LinkTimeline: React.FC<{
  multiColumn: boolean;
}> = ({ multiColumn }) => {
  const { url } = useParams<{ url: string }>();
  const decodedUrl = url ? decodeURIComponent(url) : undefined;
  const dispatch = useAppDispatch();
  const columnRef = useRef<ColumnRef>(null);
  const firstStatusId = useAppSelector((state) =>
    decodedUrl
      ? state.timelines.get(`link:${decodedUrl}`)?.get('items').first()
      : undefined,
  );
  // The card is an Immutable Map in the store (not a `Card` record): its
  // title is read with `get`.
  const title = useAppSelector((state) =>
    firstStatusId
      ? state.statuses.get(firstStatusId)?.get('card')?.get('title')
      : undefined,
  );

  const handleHeaderClick = useCallback(() => {
    columnRef.current?.scrollTop();
  }, []);

  const handleLoadMore = useCallback(
    (maxId: string) => {
      if (decodedUrl) {
        void dispatch(expandLinkTimeline(decodedUrl, { maxId }));
      }
    },
    [dispatch, decodedUrl],
  );

  useEffect(() => {
    if (decodedUrl) {
      void dispatch(expandLinkTimeline(decodedUrl));
    }
  }, [dispatch, decodedUrl]);

  return (
    <Column bindToDocument={!multiColumn} ref={columnRef} label={title}>
      <ColumnHeader
        icon='explore'
        iconComponent={TrendingUpIcon}
        title={title}
        onClick={handleHeaderClick}
        multiColumn={multiColumn}
        showBackButton
      />

      <StatusListContainer
        timelineId={`link:${decodedUrl}`}
        onLoadMore={handleLoadMore}
        trackScroll
        scrollKey={`link_timeline-${decodedUrl}`}
        bindToDocument={!multiColumn}
      />

      <Helmet>
        <title>{title}</title>
        <meta name='robots' content='noindex' />
      </Helmet>
    </Column>
  );
};

// eslint-disable-next-line import/no-default-export
export default LinkTimeline;
