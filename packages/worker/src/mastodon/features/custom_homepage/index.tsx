import { useEffect } from 'react';

import { FormattedMessage } from 'react-intl';

import { Route, Routes } from 'react-router';

import { Helmet } from '@unhead/react/helmet';

import { NavigationFocusTarget } from '@/mastodon/components/navigation_focus_target';
import { fetchServer } from 'mastodon/actions/server';
import { ServerHeroImage } from 'mastodon/components/server_hero_image';
import { TabLink, TabList } from 'mastodon/components/tab_list';
import { useAppSelector, useAppDispatch } from 'mastodon/store';

import { About } from './about';
import { LatestActivity } from './latest_activity';
import classes from './styles.module.scss';

export const CustomHomepage: React.FC = () => {
  const dispatch = useAppDispatch();
  const server = useAppSelector((state) => state.server.server);
  const path = '/overview';

  useEffect(() => {
    void dispatch(fetchServer());
  }, [dispatch]);

  return (
    <div className={classes.page}>
      <ServerHeroImage
        alt={server.item?.thumbnail.description ?? ''}
        blurhash={server.item?.thumbnail.blurhash ?? ''}
        src={server.item?.thumbnail.url ?? ''}
        srcSet={Object.keys(server.item?.thumbnail.versions ?? {})
          .map(
            (key) =>
              `${server.item?.thumbnail.versions?.[key]} ${key.replace('@', '')}`,
          )
          .join(', ')}
        className={classes.header}
      />

      <div className={classes.topSection}>
        <NavigationFocusTarget as='h1'>
          {server.item?.domain}
        </NavigationFocusTarget>
        <p>{server.item?.description}</p>
      </div>

      <TabList>
        <TabLink to={path} end>
          <FormattedMessage
            id='custom_homepage.latest_activity'
            defaultMessage='Latest activity'
          />
        </TabLink>

        <TabLink to={`${path}/about`} end>
          <FormattedMessage id='custom_homepage.about' defaultMessage='About' />
        </TabLink>
      </TabList>

      <Routes>
        <Route path={path} element={<LatestActivity />} />
        <Route path={`${path}/about`} element={<About />} />
      </Routes>

      <Helmet>
        <title>{server.item?.domain}</title>
        <meta name='robots' content='all' />
      </Helmet>
    </div>
  );
};
