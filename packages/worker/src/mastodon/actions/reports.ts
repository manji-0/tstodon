import type { ApiCreateReportParams } from '@tstodon/api';
import { apiSubmitReport } from 'mastodon/api/reports';
import type { ApiReportJSON } from 'mastodon/api_types/reports';
import type { Account } from 'mastodon/models/account';
import type { Status } from 'mastodon/models/status';
import type { AppDispatch } from 'mastodon/store';

import { openModal } from './modal';

export const REPORT_SUBMIT_REQUEST = 'REPORT_SUBMIT_REQUEST';
export const REPORT_SUBMIT_SUCCESS = 'REPORT_SUBMIT_SUCCESS';
export const REPORT_SUBMIT_FAIL    = 'REPORT_SUBMIT_FAIL';

export const initReport = (account: Account, status?: Status) => (dispatch: AppDispatch) =>
  dispatch(openModal({
    modalType: 'REPORT',
    modalProps: {
      accountId: account.get('id'),
      statusId: status?.get('id'),
    },
  }));

export const submitReport = (params: ApiCreateReportParams, onSuccess?: () => void, onFail?: () => void) => (dispatch: AppDispatch) => {
  dispatch(submitReportRequest());

  apiSubmitReport(params).then(report => {
    dispatch(submitReportSuccess(report));
    if (onSuccess) onSuccess();
  }).catch((error: unknown) => {
    dispatch(submitReportFail(error));
    if (onFail) onFail();
  });
};

export const submitReportRequest = () => ({
  type: REPORT_SUBMIT_REQUEST,
});

export const submitReportSuccess = (report: ApiReportJSON) => ({
  type: REPORT_SUBMIT_SUCCESS,
  report,
});

export const submitReportFail = (error: unknown) => ({
  type: REPORT_SUBMIT_FAIL,
  error,
});
