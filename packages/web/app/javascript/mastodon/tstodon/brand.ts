// tstodon branding (not in upstream Mastodon; see packages/web/UPSTREAM.md).

import { repository } from 'mastodon/initial_state';

export const productName = 'tstodon';

/** This project's repository, from `meta.repository` (`owner/name` on GitHub). */
export const projectUrl = `https://github.com/${repository || 'manji-0/tstodon'}`;

/** The upstream project tstodon's web app is based on. */
export const upstreamName = 'Mastodon';
export const upstreamUrl = 'https://github.com/mastodon/mastodon';

/**
 * The tstodon mark on a 64×64 grid: a speech bubble with "ts" cut out of it.
 * Draw it with `fill-rule="evenodd"`. `images/tstodon-symbol.svg` and
 * `images/tstodon-app-icon.svg` hold the same path.
 */
export const symbolPath =
  'M18 4H46A14 14 0 0 1 60 18V40A14 14 0 0 1 46 54H25L12.5 62.5L13 53.08A14 14 0 0 1 4 40V18A14 14 0 0 1 18 4Z' +
  'M17 14H23V21H28V27H23V38H28V44H17V27H12V21H17Z' +
  'M32 20H52V26H38V29H52V44H32V38H46V35H32Z';
