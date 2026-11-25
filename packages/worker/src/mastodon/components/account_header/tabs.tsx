import type { FC } from 'react';

import { FormattedMessage } from 'react-intl';

import type { Location } from 'react-router';

import { useAccount } from '@/mastodon/hooks/useAccount';
import { useAccountId } from '@/mastodon/hooks/useAccountId';
import { decodePathname, matchRoute } from '@/mastodon/utils/react_router';

import { TabLink, TabList } from '../tab_list';

import classes from './styles.module.scss';

const isActivityActive = (to: string) => (location: Location) => {
  const match = matchRoute(location.pathname, { path: to });
  const pathname = decodePathname(location.pathname);

  return (
    match?.url === pathname ||
    (!!match?.url && pathname.startsWith(`${match.url}/tagged/`))
  );
};

export const AccountTabs: FC = () => {
  const accountId = useAccountId();
  const account = useAccount(accountId);

  if (!account) {
    return <hr className={classes.noTabs} />;
  }

  const { acct, show_featured, show_media } = account;
  if (!show_featured && !show_media) {
    return <hr className={classes.noTabs} />;
  }

  return (
    <TabList>
      <TabLink isActive={isActivityActive(`/@${acct}`)} to={`/@${acct}`}>
        <FormattedMessage id='account.activity' defaultMessage='Activity' />
      </TabLink>
      {show_media && (
        <TabLink end to={`/@${acct}/media`}>
          <FormattedMessage id='account.media' defaultMessage='Media' />
        </TabLink>
      )}
      {show_featured && (
        <TabLink end to={`/@${acct}/featured`}>
          <FormattedMessage id='account.featured' defaultMessage='Featured' />
        </TabLink>
      )}
    </TabList>
  );
};
