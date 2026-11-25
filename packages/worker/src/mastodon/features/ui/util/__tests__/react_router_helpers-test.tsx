import {
  Link,
  MemoryRouter,
  Route,
  useLocation,
  useNavigationType,
  useParams,
} from 'react-router';

import { fireEvent, render, screen } from '@testing-library/react';

import { Redirect, WrappedSwitch } from '../react_router_helpers';

const Show: React.FC<{ name: string }> = ({ name }) => {
  const params = useParams();
  const location = useLocation();
  const navigationType = useNavigationType();

  return (
    <>
      <p>
        {name} {JSON.stringify(params)}
      </p>
      <p>
        at {location.pathname} {JSON.stringify(location.state)}{' '}
        {navigationType}
      </p>
      <Link to='/@bob'>Bob</Link>
    </>
  );
};

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      {/* `from` and `exact` are read by WrappedSwitch, not by the elements */}
      <WrappedSwitch multiColumn={false}>
        {/* @ts-expect-error - see above */}
        <Redirect from='/' to='/home' state={{ focusTarget: false }} exact />
        <Route path='/home' element={<Show name='home' />} />
        <Route path='/@:acct/featured' element={<Show name='featured' />} />
        <Route
          path='/@:acct/:statusId'
          // @ts-expect-error - see above
          exact
          element={<Show name='status' />}
        />
        {/* @ts-expect-error - see above */}
        <Route path='/@:acct' exact element={<Show name='account' />} />
        <Route path='/tags/:id' element={<Show name='tag' />} />
        <Route path='/links/:url' element={<Show name='link' />} />
        <Route
          path='/terms-of-service/:date?'
          element={<Show name='terms' />}
        />
        <Route element={<Show name='not found' />} />
      </WrappedSwitch>
    </MemoryRouter>,
  );

describe('<WrappedSwitch />', () => {
  it.each([
    ['/@alice', 'account {"acct":"alice"}'],
    ['/@alice@example.com/123', 'status {"acct":"alice@example.com","statusId":"123"}'],
    // The first match wins, and a path without `exact` matches a prefix.
    ['/@alice/featured', 'featured {"acct":"alice"}'],
    ['/@alice/featured/more', 'featured {"acct":"alice"}'],
    ['/@alice/123/more', 'not found {}'],
    ['/nowhere', 'not found {}'],
    ['/terms-of-service', 'terms {}'],
    ['/terms-of-service/2025-01-01', 'terms {"date":"2025-01-01"}'],
    // Parameters are decoded with `decodeURI`, as history 4 did.
    ['/tags/caf%C3%A9', 'tag {"id":"café"}'],
    [
      '/links/https%3A%2F%2Fexample.com%2Fa',
      'link {"url":"https%3A%2F%2Fexample.com%2Fa"}',
    ],
  ])('renders %s with react-router 5 paths', (path, rendered) => {
    renderAt(path);

    expect(screen.getByText(rendered)).toBeTruthy();
  });

  it('redirects with the given state', async () => {
    renderAt('/');

    expect(
      await screen.findByText('at /home {"focusTarget":false} REPLACE'),
    ).toBeTruthy();
  });

  it('gives the route the navigation type', async () => {
    renderAt('/@alice');

    expect(screen.getByText('at /@alice null POP')).toBeTruthy();

    fireEvent.click(screen.getByText('Bob'));

    expect(
      await screen.findByText('account {"acct":"bob"}'),
    ).toBeTruthy();
    expect(screen.getByText('at /@bob null PUSH')).toBeTruthy();
  });
});
