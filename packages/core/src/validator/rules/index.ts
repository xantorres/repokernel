import type { ScopedRule } from '../engine.js';
import { activeFieldsRule } from './activeFields.js';
import { blockedByCycleRule } from './blockedByCycle.js';
import { blockedByRefsRule } from './blockedByRefs.js';
import { dependencyCycleRule } from './dependencyCycle.js';
import { dependencyRefsRule } from './dependencyRefs.js';
import { duplicateIdsRule } from './duplicateIds.js';
import { epicAutoCloseRule } from './epicAutoClose.js';
import { epicRefsRule } from './epicRefs.js';
import { laneOrphanRule } from './laneOrphan.js';
import { nextMdSyncRule } from './nextMdSync.js';
import { queuedDependencyShippedRule } from './queuedDependencyShipped.js';
import { queueLaneRule } from './queueLane.js';
import { queueDuplicateRule, queueRefsRule } from './queueRefs.js';
import { queueStatusRule } from './queueStatusRules.js';
import { reviewConflictRule } from './reviewConflict.js';
import { reviewIntegrityRule } from './reviewIntegrity.js';
import { reviewPanelConflictRule } from './reviewPanelConflict.js';
import { reviewRefsRule } from './reviewRefs.js';
import { shippedFieldsRule } from './shippedFields.js';
import { sprintEpicMembershipRule } from './sprintEpicMembership.js';
import { sprintPolicyRule } from './sprintPolicy.js';
import { sprintReviewByPolicyRule } from './sprintReviewByPolicy.js';
import { sprintSectionPlaceholderRule } from './sprintSectionEmpty.js';
import { unknownLaneRule } from './unknownLane.js';

export const rules: readonly ScopedRule[] = [
  { scope: 'live', run: duplicateIdsRule },
  { scope: 'live', run: sprintPolicyRule },
  { scope: 'live', run: queueRefsRule },
  { scope: 'live', run: queueDuplicateRule },
  { scope: 'live', run: queueLaneRule },
  { scope: 'live', run: laneOrphanRule },
  { scope: 'live', run: epicRefsRule },
  { scope: 'live', run: dependencyRefsRule },
  { scope: 'live', run: dependencyCycleRule },
  { scope: 'live', run: blockedByRefsRule },
  { scope: 'live', run: blockedByCycleRule },
  { scope: 'live', run: queuedDependencyShippedRule },
  { scope: 'live', run: activeFieldsRule },
  // shippedFieldsRule emits SHIPPED_SPRINT_MISSING_{CLOSED_AT,END_SHA,BASE_SHA,REVIEW}.
  // These are historical-hygiene checks on a frozen state — past close, the data
  // cannot be cheaply backfilled and re-firing on every validate produces noise.
  // Tag as `audit` so it fires only on `rk validate --audit`. Forward enforcement
  // (capturing these fields at close time) belongs in the close pipeline, not here.
  { scope: 'audit', run: shippedFieldsRule },
  { scope: 'live', run: reviewRefsRule },
  { scope: 'live', run: reviewIntegrityRule },
  { scope: 'live', run: reviewConflictRule },
  { scope: 'live', run: reviewPanelConflictRule },
  { scope: 'live', run: sprintEpicMembershipRule },
  { scope: 'live', run: sprintReviewByPolicyRule },
  { scope: 'live', run: sprintSectionPlaceholderRule },
  { scope: 'live', run: epicAutoCloseRule },
  { scope: 'live', run: queueStatusRule },
  { scope: 'live', run: nextMdSyncRule },
  { scope: 'live', run: unknownLaneRule },
];
