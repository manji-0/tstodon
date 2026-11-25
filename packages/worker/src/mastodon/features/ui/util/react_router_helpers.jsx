import PropTypes from 'prop-types';
import { Component, cloneElement, Children, isValidElement, useMemo } from 'react';

import { Navigate, Route, UNSAFE_LocationContext, renderMatches, useLocation, useNavigationType } from 'react-router';

import StackTrace from 'stacktrace-js';

import Bundle from '../components/bundle';
import BundleColumnError from '../components/bundle_column_error';
import { ColumnLoading } from '../components/column_loading';
import { forceSingleColumn, hasMultiColumnPath } from '@/mastodon/initial_state';
import { matchRoute } from '@/mastodon/utils/react_router';

// Renders the first child whose `path` (or a `Redirect`'s `from`) matches,
// as react-router 5's `Switch` did: react-router 6 and later rank routes
// instead, and cannot express Mastodon's `/@:acct` paths. A child without a
// path always matches. The route sees the location without `/deck` and its
// params through `useParams`; a `WrappedRoute` also gets them as `params`.
export const WrappedSwitch = ({ multiColumn, children }) => {
  const location = useLocation();
  const navigationType = useNavigationType();

  const decklessLocation = useMemo(() => !forceSingleColumn && hasMultiColumnPath && location.pathname.startsWith('/deck')
    ? {...location, pathname: location.pathname.slice(5)}
    : location, [location]);

  const locationContext = useMemo(() => ({ location: decklessLocation, navigationType }), [decklessLocation, navigationType]);

  let element = null;
  let match = null;

  Children.forEach(children, child => {
    if (match === null && isValidElement(child)) {
      const path = child.props.path ?? child.props.from;

      element = child;
      match = path ? matchRoute(decklessLocation.pathname, { path, exact: child.props.exact }) : { params: {}, url: '/' };
    }
  });

  if (match === null) {
    return null;
  }

  const routeElement = element.type === Route ? element.props.element : cloneElement(element, { multiColumn, params: match.params });

  return (
    <UNSAFE_LocationContext.Provider value={locationContext}>
      {renderMatches([{ params: match.params, pathname: match.url, pathnameBase: '/', route: { path: '*', element: routeElement } }])}
    </UNSAFE_LocationContext.Provider>
  );
};


WrappedSwitch.propTypes = {
  multiColumn: PropTypes.bool,
  children: PropTypes.node,
};

// Small Wrapper to extract the params from the route and pass
// them to the rendered component, together with the content to
// be rendered inside (the children)
export class WrappedRoute extends Component {

  static propTypes = {
    component: PropTypes.func.isRequired,
    content: PropTypes.node,
    multiColumn: PropTypes.bool,
    params: PropTypes.object,
    componentParams: PropTypes.object,
  };

  static defaultProps = {
    componentParams: {},
  };

  static getDerivedStateFromError () {
    return {
      hasError: true,
    };
  }

  state = {
    hasError: false,
    stacktrace: '',
  };

  componentDidCatch (error) {
    StackTrace.fromError(error).then(stackframes => {
      this.setState({ stacktrace: error.toString() + '\n' + stackframes.map(frame => frame.toString()).join('\n') });
    }).catch(err => {
      console.error(err);
    });
  }

  render () {
    const { component, content, multiColumn, params, componentParams } = this.props;
    const { hasError, stacktrace } = this.state;

    if (hasError) {
      return (
        <BundleColumnError
          stacktrace={stacktrace}
          multiColumn={multiColumn}
          errorType='error'
        />
      );
    }

    return (
      <Bundle fetchComponent={component} loading={this.renderLoading} error={this.renderError}>
        {Component => <Component params={params} multiColumn={multiColumn} {...componentParams}>{content}</Component>}
      </Bundle>
    );
  }

  renderLoading = () => {
    const { multiColumn } = this.props;

    return <ColumnLoading multiColumn={multiColumn} />;
  };

  renderError = (props) => {
    return <BundleColumnError {...props} errorType='network' />;
  };

}

// A redirect for `WrappedSwitch`, which reads `from` and `exact`
export const Redirect = ({ to, state }) => <Navigate to={to} state={state} replace />;

Redirect.propTypes = {
  from: PropTypes.string,
  exact: PropTypes.bool,
  to: PropTypes.oneOfType([PropTypes.string, PropTypes.object]).isRequired,
  state: PropTypes.object,
};
