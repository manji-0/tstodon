import { useCallback, useRef } from 'react';

import { defineMessages, useIntl, FormattedMessage } from 'react-intl';

import { NavLink, Routes, Route } from 'react-router';

import { Helmet } from '@unhead/react/helmet';

import TrendingUpIcon from '@/material-icons/400-24px/trending_up.svg?react';
import { Column } from 'mastodon/components/column';
import type { ColumnRef } from 'mastodon/components/column';
import { ColumnHeader } from 'mastodon/components/column_header';
import { SymbolLogo } from 'mastodon/components/logo';
import { Search } from 'mastodon/features/compose/components/search';
import { useBreakpoint } from 'mastodon/features/ui/hooks/useBreakpoint';
import { useIdentity } from 'mastodon/identity_context';

import Links from './links';
import Statuses from './statuses';
import Suggestions from './suggestions';
import Tags from './tags';

const messages = defineMessages({
  title: { id: 'explore.title', defaultMessage: 'Trending' },
});

const Explore: React.FC<{ multiColumn: boolean }> = ({ multiColumn }) => {
  const { signedIn } = useIdentity();
  const intl = useIntl();
  const columnRef = useRef<ColumnRef>(null);
  const logoRequired = useBreakpoint('full');

  const handleHeaderClick = useCallback(() => {
    columnRef.current?.scrollTop();
  }, []);

  return (
    <Column
      bindToDocument={!multiColumn}
      ref={columnRef}
      label={intl.formatMessage(messages.title)}
    >
      <ColumnHeader
        icon={'explore'}
        iconComponent={logoRequired ? SymbolLogo : TrendingUpIcon}
        title={intl.formatMessage(messages.title)}
        onClick={handleHeaderClick}
        multiColumn={multiColumn}
      />

      <div className='explore__search-header'>
        <Search singleColumn />
      </div>

      <div className='account__section-headline'>
        <NavLink end to='/explore'>
          <FormattedMessage
            tagName='div'
            id='explore.trending_statuses'
            defaultMessage='Posts'
          />
        </NavLink>

        <NavLink end to='/explore/tags'>
          <FormattedMessage
            tagName='div'
            id='explore.trending_tags'
            defaultMessage='Hashtags'
          />
        </NavLink>

        {signedIn && (
          <NavLink end to='/explore/suggestions'>
            <FormattedMessage
              tagName='div'
              id='explore.suggested_follows'
              defaultMessage='People'
            />
          </NavLink>
        )}

        <NavLink end to='/explore/links'>
          <FormattedMessage
            tagName='div'
            id='explore.trending_links'
            defaultMessage='News'
          />
        </NavLink>
      </div>

      <Routes>
        <Route path='/explore/tags/*' element={<Tags />} />
        <Route path='/explore/links/*' element={<Links />} />
        <Route path='/explore/suggestions/*' element={<Suggestions />} />
        <Route path='/explore' element={<Statuses multiColumn={multiColumn} />} />
        <Route
          path='/explore/posts'
          element={<Statuses multiColumn={multiColumn} />}
        />
      </Routes>

      <Helmet>
        <title>{intl.formatMessage(messages.title)}</title>
        <meta name='robots' content='all' />
      </Helmet>
    </Column>
  );
};

// eslint-disable-next-line import/no-default-export
export default Explore;
