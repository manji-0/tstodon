import { useCallback, useRef, useState } from 'react';

import { defineMessages, FormattedMessage, useIntl } from 'react-intl';

import classNames from 'classnames';

import space_elements from '@/images/archetypes/space_elements.png';
import EditIcon from '@/material-icons/400-24px/edit.svg?react';
import InsertChartIcon from '@/material-icons/400-24px/insert_chart.svg?react';
import RepeatIcon from '@/material-icons/400-24px/repeat.svg?react';
import ReplyIcon from '@/material-icons/400-24px/reply.svg?react';
import VisibilityIcon from '@/material-icons/400-24px/visibility.svg?react';
import { Avatar } from '@/mastodon/components/avatar';
import { Button } from '@/mastodon/components/button';
import { DisplayName } from '@/mastodon/components/display_name';
import { Icon } from '@/mastodon/components/icon';
import type { IconProp } from '@/mastodon/components/icon';
import { me } from '@/mastodon/initial_state';
import type { Account } from '@/mastodon/models/account';
import type {
  AnnualReport,
  Archetype as ArchetypeData,
} from '@/mastodon/models/annual_report';
import { wrapstodonSettings } from '@/mastodon/settings';

import styles from './index.module.scss';
import { ShareButton } from './share_button';

export const archetypeNames = defineMessages<ArchetypeData>({
  booster: {
    id: 'annual_report.summary.archetype.booster.name',
    defaultMessage: 'The Archer',
  },
  replier: {
    id: 'annual_report.summary.archetype.replier.name',
    defaultMessage: 'The Butterfly',
  },
  pollster: {
    id: 'annual_report.summary.archetype.pollster.name',
    defaultMessage: 'The Wonderer',
  },
  lurker: {
    id: 'annual_report.summary.archetype.lurker.name',
    defaultMessage: 'The Stoic',
  },
  oracle: {
    id: 'annual_report.summary.archetype.oracle.name',
    defaultMessage: 'The Oracle',
  },
});

export const archetypeSelfDescriptions = defineMessages<ArchetypeData>({
  booster: {
    id: 'annual_report.summary.archetype.booster.desc_self',
    defaultMessage:
      'You stayed on the hunt for posts to boost, amplifying other creators with perfect aim.',
  },
  replier: {
    id: 'annual_report.summary.archetype.replier.desc_self',
    defaultMessage:
      'You frequently replied to other people’s posts, pollinating the fediverse with new discussions.',
  },
  pollster: {
    id: 'annual_report.summary.archetype.pollster.desc_self',
    defaultMessage:
      'You created more polls than other post types, cultivating curiosity on the fediverse.',
  },
  lurker: {
    id: 'annual_report.summary.archetype.lurker.desc_self',
    defaultMessage:
      'We know you were out there, somewhere, enjoying the fediverse in your own quiet way.',
  },
  oracle: {
    id: 'annual_report.summary.archetype.oracle.desc_self',
    defaultMessage:
      'You created new posts more than replies, keeping the fediverse fresh and future-facing.',
  },
});

export const archetypePublicDescriptions = defineMessages<ArchetypeData>({
  booster: {
    id: 'annual_report.summary.archetype.booster.desc_public',
    defaultMessage:
      '{name} stayed on the hunt for posts to boost, amplifying other creators with perfect aim.',
  },
  replier: {
    id: 'annual_report.summary.archetype.replier.desc_public',
    defaultMessage:
      '{name} frequently replied to other people’s posts, pollinating the fediverse with new discussions.',
  },
  pollster: {
    id: 'annual_report.summary.archetype.pollster.desc_public',
    defaultMessage:
      '{name} created more polls than other post types, cultivating curiosity on the fediverse.',
  },
  lurker: {
    id: 'annual_report.summary.archetype.lurker.desc_public',
    defaultMessage:
      'We know {name} was out there, somewhere, enjoying the fediverse in their own quiet way.',
  },
  oracle: {
    id: 'annual_report.summary.archetype.oracle.desc_public',
    defaultMessage:
      '{name} created new posts more than replies, keeping the fediverse fresh and future-facing.',
  },
});

// tstodon: neutral icons in place of Mastodon's mascot illustrations.
const illustrations = {
  booster: RepeatIcon,
  replier: ReplyIcon,
  pollster: InsertChartIcon,
  lurker: VisibilityIcon,
  oracle: EditIcon,
} as const satisfies Record<ArchetypeData, IconProp>;

export const Archetype: React.FC<{
  report: AnnualReport;
  account?: Account;
  context: 'modal' | 'standalone';
}> = ({ report, account, context }) => {
  const intl = useIntl();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const isSelfView = context === 'modal';

  const [isRevealed, setIsRevealed] = useState(
    () =>
      !isSelfView ||
      (me ? (wrapstodonSettings.get(me)?.archetypeRevealed ?? false) : true),
  );
  const reveal = useCallback(() => {
    setIsRevealed(true);
    if (me) {
      wrapstodonSettings.set(me, { archetypeRevealed: true });
    }
    wrapperRef.current?.focus();
  }, []);

  const archetype = report.data.archetype;
  const descriptions = isSelfView
    ? archetypeSelfDescriptions
    : archetypePublicDescriptions;

  return (
    <div
      className={classNames(styles.box, styles.archetype)}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      ref={wrapperRef}
    >
      <div className={styles.archetypeArtboard}>
        {account && (
          <Avatar
            account={account}
            size={50}
            className={styles.archetypeAvatar}
          />
        )}
        <div className={styles.archetypeIllustrationWrapper}>
          <Icon
            id={archetype}
            icon={illustrations[archetype]}
            className={isRevealed ? undefined : styles.blurredImage}
            style={{
              width: '100%',
              height: '100%',
              padding: 20,
              boxSizing: 'border-box',
              background: 'var(--color-bg-brand-softest)',
              color: 'var(--color-text-brand)',
            }}
          />
        </div>
        <img
          src={space_elements}
          alt=''
          className={styles.archetypePlanetRing}
        />
      </div>
      <div className={classNames(styles.content, styles.comfortable)}>
        <h2 className={styles.title}>
          {isSelfView ? (
            <FormattedMessage
              id='annual_report.summary.archetype.title_self'
              defaultMessage='Your archetype'
            />
          ) : (
            <FormattedMessage
              id='annual_report.summary.archetype.title_public'
              defaultMessage="{name}'s archetype"
              values={{
                name: <DisplayName variant='simple' account={account} />,
              }}
            />
          )}
        </h2>
        <p className={styles.statLarge}>
          {isRevealed ? (
            intl.formatMessage(archetypeNames[archetype])
          ) : (
            <FormattedMessage
              id='annual_report.summary.archetype.die_drei_fragezeichen'
              defaultMessage='???'
            />
          )}
        </p>
        <p>
          {isRevealed ? (
            intl.formatMessage(descriptions[archetype], {
              name: <DisplayName variant='simple' account={account} />,
            })
          ) : (
            <FormattedMessage
              id='annual_report.summary.archetype.reveal_description'
              defaultMessage='Thanks for being part of the fediverse! Time to find out which archetype you embodied in {year}.'
              values={{ year: report.year }}
            />
          )}
        </p>
      </div>
      {!isRevealed && (
        <Button onClick={reveal}>
          <FormattedMessage
            id='annual_report.summary.archetype.reveal'
            defaultMessage='Reveal my archetype'
          />
        </Button>
      )}
      {isRevealed && isSelfView && <ShareButton report={report} />}
    </div>
  );
};
