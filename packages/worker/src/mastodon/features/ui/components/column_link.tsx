import classNames from 'classnames';
import { Link, NavLink, useLocation } from 'react-router';

import { Icon } from 'mastodon/components/icon';
import type { IconProp } from 'mastodon/components/icon';
import type {
  LocationState,
  MastodonLocationDescriptor,
} from 'mastodon/components/router';
import { matchRoute } from 'mastodon/utils/react_router';

export const ColumnLink: React.FC<{
  icon: React.ReactNode;
  iconComponent?: IconProp;
  activeIcon?: React.ReactNode;
  activeIconComponent?: IconProp;
  isActive?: (match: unknown, location: { pathname: string }) => boolean;
  text: string;
  to?: MastodonLocationDescriptor;
  state?: LocationState;
  href?: string;
  method?: string;
  badge?: React.ReactNode;
  transparent?: boolean;
  className?: string;
  id?: string;
}> = ({
  icon,
  activeIcon,
  iconComponent,
  activeIconComponent,
  text,
  to,
  href,
  method,
  badge,
  transparent,
  isActive,
  ...other
}) => {
  const location = useLocation();
  const match = matchRoute(location.pathname, {
    path: (typeof to === 'string' ? to : to?.pathname) ?? '',
  });
  const className = classNames('column-link', {
    'column-link--transparent': transparent,
  });
  const badgeElement =
    typeof badge !== 'undefined' ? (
      <span className='column-link__badge'>{badge}</span>
    ) : null;
  const iconElement = iconComponent ? (
    <Icon
      id={typeof icon === 'string' ? icon : ''}
      icon={iconComponent}
      className='column-link__icon'
    />
  ) : (
    icon
  );
  const activeIconElement =
    activeIcon ??
    (activeIconComponent ? (
      <Icon
        id={typeof icon === 'string' ? icon : ''}
        icon={activeIconComponent}
        className='column-link__icon'
      />
    ) : (
      iconElement
    ));
  const active = !!match;

  if (href) {
    return (
      <a href={href} className={className} data-method={method} {...other}>
        {active ? activeIconElement : iconElement}
        <span>{text}</span>
        {badgeElement}
      </a>
    );
  } else if (to && isActive) {
    const linkActive = isActive(match, location);

    return (
      <Link
        to={to}
        className={classNames(className, { active: linkActive })}
        aria-current={linkActive ? 'page' : undefined}
        {...other}
      >
        {active ? activeIconElement : iconElement}
        <span>{text}</span>
        {badgeElement}
      </Link>
    );
  } else if (to) {
    return (
      <NavLink to={to} className={className} {...other}>
        {active ? activeIconElement : iconElement}
        <span>{text}</span>
        {badgeElement}
      </NavLink>
    );
  } else {
    return null;
  }
};
