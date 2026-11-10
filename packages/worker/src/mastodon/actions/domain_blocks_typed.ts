import { createAction } from '@reduxjs/toolkit';

// `accounts` are the ids of the known accounts on `domain` (upstream typed
// them `Account[]`, but always dispatched ids).
export const blockDomainSuccess = createAction<{
  domain: string;
  accounts: string[];
}>('domain_blocks/block/SUCCESS');

export const unblockDomainSuccess = createAction<{
  domain: string;
  accounts: string[];
}>('domain_blocks/unblock/SUCCESS');
