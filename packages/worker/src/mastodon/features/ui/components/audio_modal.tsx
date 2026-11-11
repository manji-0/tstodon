import { useEffect } from 'react';

import { getAverageFromBlurhash } from 'mastodon/blurhash';
import type { RGB } from 'mastodon/blurhash';
import { Audio } from 'mastodon/features/audio';
import { Footer } from 'mastodon/features/picture_in_picture/components/footer';
import type { MediaAttachmentFields } from 'mastodon/models/status';
import { useAppSelector } from 'mastodon/store';
import type { ImmutableMapReaderOf } from 'mastodon/utils/immutable_map_of';

const AudioModal: React.FC<{
  media: ImmutableMapReaderOf<MediaAttachmentFields>;
  statusId: string;
  options: {
    autoPlay: boolean;
  };
  onClose: () => void;
  onChangeBackgroundColor: (color: RGB | null) => void;
}> = ({ media, statusId, options, onClose, onChangeBackgroundColor }) => {
  const status = useAppSelector((state) => state.statuses.get(statusId));
  const accountId = status?.get('account');
  const accountStaticAvatar = useAppSelector((state) =>
    accountId ? state.accounts.get(accountId)?.avatar_static : undefined,
  );

  useEffect(() => {
    const backgroundColor = getAverageFromBlurhash(media.get('blurhash'));

    onChangeBackgroundColor(backgroundColor ?? { r: 255, g: 255, b: 255 });

    return () => {
      onChangeBackgroundColor(null);
    };
  }, [media, onChangeBackgroundColor]);

  const language =
    status?.get('translation')?.get('language') ??
    status?.get('language') ??
    undefined;
  const description =
    media.get('translation')?.get('description') ??
    media.get('description') ??
    undefined;

  return (
    <div className='modal-root__modal audio-modal'>
      <div className='audio-modal__container'>
        <Audio
          src={media.get('url')}
          alt={description}
          lang={language}
          poster={media.get('preview_url') ?? accountStaticAvatar}
          duration={media.getIn(['meta', 'original', 'duration'], 0) as number}
          backgroundColor={
            media.getIn(['meta', 'colors', 'background']) as string
          }
          foregroundColor={
            media.getIn(['meta', 'colors', 'foreground']) as string
          }
          accentColor={media.getIn(['meta', 'colors', 'accent']) as string}
          startPlaying={options.autoPlay}
        />
      </div>

      <div className='media-modal__overlay'>
        {status && (
          <Footer
            statusId={status.get('id')}
            withOpenButton
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
};

// eslint-disable-next-line import/no-default-export
export default AudioModal;
