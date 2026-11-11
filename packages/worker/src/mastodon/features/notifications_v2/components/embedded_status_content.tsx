import { useCallback, useMemo } from 'react';

import { EmojiHTML } from '@/mastodon/components/emoji/html';
import { useElementHandledLink } from '@/mastodon/components/status/handled_link';
import type { Status } from '@/mastodon/models/status';
import { immutableToJS } from '@/mastodon/utils/immutable_map_of';

export const EmbeddedStatusContent: React.FC<{
  status: Status;
  className?: string;
}> = ({ status, className }) => {
  const mentions = useMemo(
    () => immutableToJS(status.get('mentions')),
    [status],
  );
  const emojis = useMemo(() => immutableToJS(status.get('emojis')), [status]);
  const hrefToMention = useCallback(
    (href: string) => {
      return mentions.find((item) => item.url === href);
    },
    [mentions],
  );
  const hrefToCollection = useCallback(
    (href: string) => {
      const collection = status
        .get('tagged_collections')
        .find((item) => item.get('url') === href);
      return collection?.get('id');
    },
    [status],
  );
  const htmlHandlers = useElementHandledLink({
    hashtagAccountId: status.get('account'),
    hrefToCollectionId: hrefToCollection,
    hrefToMention,
  });

  return (
    <EmojiHTML
      {...htmlHandlers}
      className={className}
      lang={status.get('language') ?? undefined}
      htmlString={status.get('contentHtml', '')}
      extraEmojis={emojis}
    />
  );
};
