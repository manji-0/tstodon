import type { FC } from 'react';

import { FormattedMessage } from 'react-intl';

import { DisplayName } from '@/mastodon/components/display_name';
import { IconLogo } from '@/mastodon/components/logo';
import { useAppSelector } from '@/mastodon/store';
import { projectUrl } from '@/mastodon/tstodon/brand';

import { AnnualReport, accountSelector } from './index';
import classes from './shared_page.module.scss';

export const WrapstodonSharedPage: FC = () => {
  const account = useAppSelector(accountSelector);
  const domain = useAppSelector((state) => state.meta.get('domain') as string);
  return (
    <main className={classes.wrapper}>
      <AnnualReport />
      <footer className={classes.footer}>
        <div className={classes.footerSection}>
          <IconLogo className={classes.logo} />
          <FormattedMessage
            id='annual_report.shared_page.footer'
            defaultMessage='Generated with {heart} by tstodon'
            values={{ heart: '❤️' }}
            tagName='p'
          />
          <ul className={classes.linkList}>
            <li>
              <a href={projectUrl}>
                <FormattedMessage
                  id='footer.about_mastodon'
                  defaultMessage='About tstodon'
                />
              </a>
            </li>
          </ul>
        </div>

        <div className={classes.footerSection}>
          <FormattedMessage
            id='annual_report.shared_page.footer_server_info'
            defaultMessage='{username} uses {domain}, one of many communities in the fediverse.'
            values={{
              username: <DisplayName variant='simple' account={account} />,
              domain: <strong>{domain}</strong>,
            }}
            tagName='p'
          />
          <a href='/about'>
            <FormattedMessage
              id='footer.about_server'
              defaultMessage='About {domain}'
              values={{ domain }}
            />
          </a>
        </div>
      </footer>
    </main>
  );
};
