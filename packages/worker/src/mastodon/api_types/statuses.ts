// See app/serializers/rest/status_serializer.rb; the REST shapes live in
// @tstodon/api (packages/api), shared with the server.

import { isStatusVisibility as isSharedStatusVisibility } from '@tstodon/api/values';

import type { StatusVisibility } from '@tstodon/api/values';

export type {
  StatusVisibility,
  FilterContext,
  ApiStatusApplicationJSON,
  ApiTagJSON,
  ApiMentionJSON,
  ApiPreviewCardAuthorJSON,
  ApiPreviewCardJSON,
  ApiFilterJSON,
  ApiFilterResultJSON,
  ApiStatusJSON,
  ApiContextJSON,
  ApiStatusSourceJSON,
} from '@tstodon/api';

// The client's translation shape (`contentHtml` and `spoilerHtml` are added
// when it is imported); the wire entity is @tstodon/api's ApiTranslationJSON.
export interface ApiStatusTranslationJSON {
  detected_source_language: string;
  language: string;
  provider: string;
  contentHtml: string;
  spoilerHtml: string;
  spoiler_text: string;
  poll?: {
    id: string;
    options: { title: string }[];
  };
}

export function isStatusVisibility(
  visibility: string,
): visibility is StatusVisibility {
  return isSharedStatusVisibility(visibility);
}
