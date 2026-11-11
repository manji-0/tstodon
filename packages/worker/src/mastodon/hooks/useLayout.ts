import { useAppSelector } from '../store';

export const useLayout = () => {
  const layout = useAppSelector((state) => state.meta.get('layout'));

  return {
    singleColumn: layout === 'single-column' || layout === 'mobile',
    multiColumn: layout === 'multi-column',
    layout,
  };
};
