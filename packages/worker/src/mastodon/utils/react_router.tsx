import PropTypes from 'prop-types';

import {
  useInRouterContext,
  useLocation,
  useNavigate,
  useNavigationType,
} from 'react-router';

import hoistStatics from 'hoist-non-react-statics';
import pathToRegexp from 'path-to-regexp';

export const WithRouterPropTypes = {
  location: PropTypes.object.isRequired,
  navigate: PropTypes.func.isRequired,
  navigationType: PropTypes.string.isRequired,
};

export const WithOptionalRouterPropTypes = {
  location: PropTypes.object,
  navigate: PropTypes.func,
  navigationType: PropTypes.string,
};

export interface OptionalRouterProps {
  ref: unknown;
  wrappedComponentRef?: string | ((...args: unknown[]) => unknown) | object;
}

const RoutedComponent: React.FC<{
  component: React.ElementType;
  props: Record<string, unknown>;
  componentRef: OptionalRouterProps['wrappedComponentRef'];
}> = ({ component: Component, props, componentRef }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();

  return (
    <Component
      {...props}
      location={location}
      navigate={navigate}
      navigationType={navigationType}
      ref={componentRef}
    />
  );
};

// Gives a class component the router's `location`, `navigate` and
// `navigationType` as props, as react-router 5's `withRouter` gave it
// `location` and `history`
export function withRouter<
  ComponentType extends React.ComponentType<OptionalRouterProps>,
>(Component: ComponentType) {
  const displayName = `withRouter(${Component.displayName ?? Component.name})`;
  const C = (props: React.ComponentProps<ComponentType>) => {
    const { wrappedComponentRef, ...remainingProps } = props;

    return (
      <RoutedComponent
        component={Component}
        props={remainingProps}
        componentRef={wrappedComponentRef}
      />
    );
  };

  C.displayName = displayName;
  C.WrappedComponent = Component;

  return hoistStatics(C, Component);
}

// Same as `withRouter`, but does not fail if called outside of a router
export function withOptionalRouter<
  ComponentType extends React.ComponentType<OptionalRouterProps>,
>(Component: ComponentType) {
  const displayName = `withRouter(${Component.displayName ?? Component.name})`;
  const C = (props: React.ComponentProps<ComponentType>) => {
    const { wrappedComponentRef, ...remainingProps } = props;
    const inRouter = useInRouterContext();

    if (inRouter) {
      return (
        <RoutedComponent
          component={Component}
          props={remainingProps}
          componentRef={wrappedComponentRef}
        />
      );
    }

    // @ts-expect-error - Dynamic covariant generic components are tough to type.
    return <Component {...remainingProps} ref={wrappedComponentRef} />;
  };

  C.displayName = displayName;
  C.WrappedComponent = Component;

  return hoistStatics(C, Component);
}

export interface RouteMatch {
  path: string;
  url: string;
  isExact: boolean;
  params: Record<string, string | undefined>;
}

const compiledPaths = new Map<
  string,
  { regexp: RegExp; keys: pathToRegexp.Key[] }
>();

function compilePath(path: string, exact: boolean) {
  const cacheKey = `${exact}:${path}`;
  let compiled = compiledPaths.get(cacheKey);

  if (!compiled) {
    const keys: pathToRegexp.Key[] = [];
    compiled = { regexp: pathToRegexp(path, keys, { end: exact }), keys };
    compiledPaths.set(cacheKey, compiled);
  }

  return compiled;
}

// A pathname as react-router 5 saw it: history 4 decoded it with `decodeURI`
export function decodePathname(pathname: string) {
  try {
    return decodeURI(pathname);
  } catch {
    return pathname;
  }
}

// react-router 5's `matchPath`, with its path syntax (path-to-regexp 1, as
// react-router 5 used): react-router 6 and later cannot express a parameter
// inside a segment, as in `/@:acct`. The pathname is decoded with `decodeURI`
// first, as history 4 did for react-router 5, so parameters keep the values
// they had.
export function matchRoute(
  pathname: string,
  { path, exact = false }: { path: string | string[]; exact?: boolean },
): RouteMatch | null {
  const decodedPathname = decodePathname(pathname);

  for (const candidate of Array.isArray(path) ? path : [path]) {
    const { regexp, keys } = compilePath(candidate, exact);
    const match = regexp.exec(decodedPathname);

    if (!match) continue;

    const [url = '', ...values] = match;
    const isExact = decodedPathname === url;

    if (exact && !isExact) continue;

    return {
      path: candidate,
      url: candidate === '/' && url === '' ? '/' : url,
      isExact,
      params: Object.fromEntries(
        keys.map((key, index) => [key.name, values[index]]),
      ),
    };
  }

  return null;
}
