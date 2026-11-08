import { FormattedMessage } from 'react-intl';

import HourglassIcon from '@/material-icons/400-24px/hourglass.svg?react';

import { Icon } from './icon';

export const RegenerationIndicator: React.FC = () => (
  <div className='regeneration-indicator'>
    <Icon
      id='hourglass'
      icon={HourglassIcon}
      style={{ width: 64, height: 64, marginBottom: 16 }}
    />

    <div className='regeneration-indicator__label'>
      <strong>
        <FormattedMessage
          id='regeneration_indicator.preparing_your_home_feed'
          defaultMessage='Preparing your home feed…'
        />
      </strong>
      <FormattedMessage
        id='regeneration_indicator.please_stand_by'
        defaultMessage='Please stand by.'
        tagName='span'
      />
    </div>
  </div>
);
