import type { ComponentPropsWithoutRef, FC } from 'react';

import classNames from 'classnames';
import type { LinkProps, Location } from 'react-router';
import { Link, NavLink, useLocation } from 'react-router';

import classes from './styles.module.scss';

interface TabListProps {
  /**
   * Setting this will remove the default border and
   * horizontal padding from the component
   */
  plain?: boolean;
}

/**
 * Display a simple row of links as tabs.
 * The current page will be highlighted automatically based on the link destination.
 */
export const TabList: FC<TabListProps & ComponentPropsWithoutRef<'div'>> = ({
  plain,
  className,
  children,
  ...otherProps
}) => {
  return (
    <div
      {...otherProps}
      className={classNames(
        className,
        classes.tabList,
        !plain && classes.withSpaceAndBorder,
      )}
    >
      {children}
    </div>
  );
};

interface TabLinkProps extends LinkProps {
  className?: string;
  end?: boolean;
  // Decides when the tab is the current page, instead of matching `to`
  isActive?: (location: Location) => boolean;
}

export const TabLink: FC<TabLinkProps> = ({
  className,
  end,
  isActive,
  children,
  ...otherProps
}) => {
  const location = useLocation();

  if (isActive) {
    const active = isActive(location);

    return (
      <Link
        className={classNames(classes.tab, className, { active })}
        aria-current={active ? 'page' : undefined}
        {...otherProps}
      >
        {children}
      </Link>
    );
  }

  return (
    <NavLink
      className={classNames(classes.tab, className)}
      end={end}
      {...otherProps}
    >
      {children}
    </NavLink>
  );
};
