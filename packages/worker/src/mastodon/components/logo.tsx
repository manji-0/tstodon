import classNames from 'classnames';

import { productName, symbolPath } from 'mastodon/tstodon/brand';

// tstodon's mark replaces Mastodon's logos here; the component names stay
// upstream's so their callers are unchanged.

export const WordmarkLogo: React.FC = () => (
  <svg viewBox='0 0 236 64' className='logo logo--wordmark' role='img'>
    <title>{productName}</title>
    <path d={symbolPath} fill='currentColor' fillRule='evenodd' />
    <text
      x='74'
      y='46'
      fill='currentColor'
      fontFamily='inherit'
      fontSize='44'
      fontWeight='700'
      textLength='160'
      lengthAdjust='spacingAndGlyphs'
      aria-hidden='true'
    >
      {productName}
    </text>
  </svg>
);

export const IconLogo: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox='0 0 64 64'
    className={classNames('logo logo--icon', className)}
    role='img'
  >
    <title>{productName}</title>
    <path d={symbolPath} fill='currentColor' fillRule='evenodd' />
  </svg>
);

/** The mark in the theme's brand colour (where Mastodon showed its coloured logo). */
export const SymbolLogo: React.FC = () => (
  <svg viewBox='0 0 64 64' className='logo logo--icon' role='img'>
    <title>{productName}</title>
    <path
      d={symbolPath}
      fill='var(--color-bg-brand-base, #4c5fd5)'
      fillRule='evenodd'
    />
  </svg>
);
