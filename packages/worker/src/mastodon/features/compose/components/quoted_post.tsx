import { useCallback, useMemo } from 'react';
import type { FC } from 'react';

import { quoteComposeCancel } from '@/mastodon/actions/compose_typed';
import { QuotedStatus } from '@/mastodon/components/status_quoted';
import { useAppDispatch, useAppSelector } from '@/mastodon/store';
import { immutableMapOf } from '@/mastodon/utils/immutable_map_of';

import { QuotePlaceholder } from './quote_placeholder';

export const ComposeQuotedStatus: FC = () => {
  const quotedStatusId = useAppSelector((state) =>
    state.compose.get('quoted_status_id'),
  );

  const isFetchingLink = useAppSelector(
    (state) => !!state.compose.get('fetching_link'),
  );

  const isEditing = useAppSelector((state) => !!state.compose.get('id'));

  const quote = useMemo(
    () =>
      quotedStatusId
        ? immutableMapOf({
            state: 'accepted' as const,
            quoted_status: quotedStatusId,
          })
        : null,
    [quotedStatusId],
  );

  const dispatch = useAppDispatch();
  const handleQuoteCancel = useCallback(() => {
    dispatch(quoteComposeCancel());
  }, [dispatch]);

  if (isFetchingLink && !quote) {
    return <QuotePlaceholder />;
  } else if (!quote) {
    return null;
  }

  return (
    <QuotedStatus
      quote={quote}
      contextType='composer'
      onQuoteCancel={!isEditing ? handleQuoteCancel : undefined}
    />
  );
};
