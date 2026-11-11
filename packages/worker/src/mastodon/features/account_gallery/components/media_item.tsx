import { useState, useCallback } from 'react';

import classNames from 'classnames';

import HeadphonesIcon from '@/material-icons/400-24px/headphones-fill.svg?react';
import MovieIcon from '@/material-icons/400-24px/movie-fill.svg?react';
import VisibilityOffIcon from '@/material-icons/400-24px/visibility_off.svg?react';
import { AltTextBadge } from 'mastodon/components/alt_text_badge';
import { Blurhash } from 'mastodon/components/blurhash';
import { Icon } from 'mastodon/components/icon';
import { formatTime } from 'mastodon/features/video';
import { autoPlayGif, displayMedia, useBlurhash } from 'mastodon/initial_state';
import type { MediaAttachmentFields, Status } from 'mastodon/models/status';
import { useAppSelector } from 'mastodon/store';
import type { ImmutableMapOf } from 'mastodon/utils/immutable_map_of';

/**
 * An attachment in the gallery, with the status it belongs to
 * (`selectGalleryTimeline`).
 */
export type GalleryMediaAttachment = ImmutableMapOf<
  Omit<MediaAttachmentFields, 'status'> & { status: Status }
>;

export const MediaItem: React.FC<{
  attachment: GalleryMediaAttachment;
  onOpenMedia: (arg0: GalleryMediaAttachment) => void;
}> = ({ attachment, onOpenMedia }) => {
  const account = useAppSelector((state) =>
    state.accounts.get(attachment.get('status').get('account')),
  );
  const [visible, setVisible] = useState(
    (displayMedia !== 'hide_all' &&
      !attachment.get('status').get('sensitive')) ||
      displayMedia === 'show_all',
  );
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const handleImageLoad = useCallback(() => {
    setLoaded(true);
  }, [setLoaded]);

  const handleImageError = useCallback(() => {
    setError(true);
  }, [setError]);

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      if (e.target instanceof HTMLVideoElement) {
        void e.target.play();
      }
    },
    [],
  );

  const handleMouseLeave = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      if (e.target instanceof HTMLVideoElement) {
        e.target.pause();
        e.target.currentTime = 0;
      }
    },
    [],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (e.button === 0 && !(e.ctrlKey || e.metaKey)) {
        e.preventDefault();

        if (visible) {
          onOpenMedia(attachment);
        } else {
          setVisible(true);
        }
      }
    },
    [attachment, visible, onOpenMedia, setVisible],
  );

  const status = attachment.get('status');
  const description =
    attachment.get('translation')?.get('description') ||
    (attachment.get('description') ?? undefined);
  const previewUrl = attachment.get('preview_url') ?? undefined;
  const fullUrl = attachment.get('url');
  const avatarUrl = account?.avatar_static;
  const lang = status.get('language') ?? undefined;
  const blurhash = attachment.get('blurhash');
  const statusId = status.get('id');
  const type = attachment.get('type');

  let thumbnail;

  const badges = [];

  if (description && description.length > 0) {
    badges.push(<AltTextBadge key='alt' description={description} />);
  }

  if (!visible) {
    thumbnail = (
      <div className='media-gallery__item__overlay'>
        <Icon id='eye-slash' icon={VisibilityOffIcon} />
      </div>
    );
  } else if (type === 'audio') {
    thumbnail = (
      <>
        <img
          src={previewUrl || avatarUrl}
          alt={description}
          lang={lang}
          onLoad={handleImageLoad}
          onError={handleImageError}
        />

        <div className='media-gallery__item__overlay media-gallery__item__overlay--corner'>
          <Icon id='music' icon={HeadphonesIcon} />
        </div>
      </>
    );
  } else if (type === 'image') {
    const focusX = (attachment.getIn(['meta', 'focus', 'x']) || 0) as number;
    const focusY = (attachment.getIn(['meta', 'focus', 'y']) || 0) as number;
    const x = (focusX / 2 + 0.5) * 100;
    const y = (focusY / -2 + 0.5) * 100;

    thumbnail = (
      <img
        src={previewUrl}
        alt={description}
        lang={lang}
        style={{ objectPosition: `${x}% ${y}%` }}
        onLoad={handleImageLoad}
        onError={handleImageError}
      />
    );
  } else if (['video', 'gifv'].includes(type)) {
    const duration = attachment.getIn([
      'meta',
      'original',
      'duration',
    ]) as number;

    thumbnail = (
      <div className='media-gallery__gifv'>
        <video
          className='media-gallery__item-gifv-thumbnail'
          aria-label={description}
          lang={lang}
          src={fullUrl}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onLoadedData={handleImageLoad}
          autoPlay={autoPlayGif}
          playsInline
          loop
          muted
        />

        {type === 'video' && (
          <div className='media-gallery__item__overlay media-gallery__item__overlay--corner'>
            <Icon id='play' icon={MovieIcon} />
          </div>
        )}
      </div>
    );

    if (type === 'gifv') {
      badges.push(
        <span
          key='gif'
          className='media-gallery__alt__label media-gallery__alt__label--non-interactive'
        >
          GIF
        </span>,
      );
    } else {
      badges.push(
        <span
          key='video'
          className='media-gallery__alt__label media-gallery__alt__label--non-interactive'
        >
          {formatTime(Math.floor(duration))}
        </span>,
      );
    }
  }

  return (
    <div
      className={classNames('media-gallery__item media-gallery__item--square', {
        'media-gallery__item--error': error,
      })}
    >
      <Blurhash
        hash={blurhash}
        className={classNames('media-gallery__preview', {
          'media-gallery__preview--hidden': visible && loaded,
        })}
        dummy={!useBlurhash}
      />

      <a
        className='media-gallery__item-thumbnail'
        href={`/@${account?.acct}/${statusId}`}
        onClick={handleClick}
        target='_blank'
        rel='noopener noreferrer'
      >
        {thumbnail}
      </a>

      {badges.length > 0 && (
        <div className='media-gallery__item__badges'>{badges}</div>
      )}
    </div>
  );
};
