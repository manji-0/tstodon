import PropTypes from 'prop-types';
import { PureComponent } from 'react';

import { FormattedMessage } from 'react-intl';


import ImmutablePropTypes from 'react-immutable-proptypes';
import { connect } from 'react-redux';

import { fetchTrendingLinks } from 'mastodon/actions/trends';
import { DismissableBanner } from 'mastodon/components/dismissable_banner';
import { LoadingIndicator } from 'mastodon/components/loading_indicator';
import { WithRouterPropTypes, withRouter } from 'mastodon/utils/react_router';

import { Story } from './components/story';

const mapStateToProps = state => ({
  links: state.getIn(['trends', 'links', 'items']),
  isLoading: state.getIn(['trends', 'links', 'isLoading']),
});

class Links extends PureComponent {

  static propTypes = {
    links: ImmutablePropTypes.list,
    isLoading: PropTypes.bool,
    dispatch: PropTypes.func.isRequired,
    ...WithRouterPropTypes,
  };

  componentDidMount () {
    const { dispatch, links, navigationType } = this.props;

    // If we're navigating back to the screen, do not trigger a reload
    if (navigationType === 'POP' && links.size > 0) {
      return;
    }

    dispatch(fetchTrendingLinks());
  }

  render () {
    const { isLoading, links } = this.props;

    if (!isLoading && links.isEmpty()) {
      return (
        <div className='explore__links scrollable scrollable--flex'>
          <div className='empty-column-indicator'>
            <FormattedMessage id='empty_column.explore_statuses' defaultMessage='Nothing is trending right now. Check back later!' tagName='span' />
          </div>
        </div>
      );
    }

    return (
      <div className='explore__links scrollable' data-nosnippet>
        {isLoading ? (<LoadingIndicator />) : links.map((link, i) => (
          <Story
            key={link.get('id')}
            expanded={i === 0}
            lang={link.get('language')}
            url={link.get('url')}
            title={link.get('title')}
            publisher={link.get('provider_name')}
            publishedAt={link.get('published_at')}
            author={link.get('author_name')}
            authorAccount={link.getIn(['authors', 0, 'account', 'id'])}
            sharedTimes={link.getIn(['history', 0, 'accounts']) * 1 + link.getIn(['history', 1, 'accounts']) * 1}
            thumbnail={link.get('image')}
            thumbnailDescription={link.get('image_description')}
            blurhash={link.get('blurhash')}
          />
        ))}
      </div>
    );
  }

}

export default connect(mapStateToProps)(withRouter(Links));
