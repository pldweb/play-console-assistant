/** Stage registry shared by the service worker and the content script. */
import { createAppStage } from './create-app-adapter.js';
import { storeListingStage } from './store-listing-adapter.js';
import { appContentStage } from './app-content-adapter.js';
import { releaseStage } from './release-adapter.js';
import { reviewReadinessStage, submissionStage } from './review-readiness-adapter.js';

export const STAGE_DEFINITIONS = Object.freeze({
  CREATE_APP: createAppStage,
  STORE_LISTING: storeListingStage,
  APP_CONTENT: appContentStage,
  RELEASE: releaseStage,
  REVIEW_READINESS: reviewReadinessStage,
  SUBMISSION: submissionStage,
});

export function getStep(stageId, stepId) {
  const stage = STAGE_DEFINITIONS[stageId];
  const step = stage && stage.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`Unknown step ${stageId}/${stepId}`);
  return step;
}
