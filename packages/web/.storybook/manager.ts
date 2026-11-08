import { addons } from 'storybook/manager-api';
import { themes } from 'storybook/theming';

addons.setConfig({
  theme: {
    ...themes.normal,
    brandTitle: 'tstodon Storybook',
    brandImage: 'logo.svg',
    colorSecondary: '#6364FF',
  },
});
