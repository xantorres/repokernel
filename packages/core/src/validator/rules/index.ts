import type { ValidatorRule } from '../engine.js';
import { activeFieldsRule } from './activeFields.js';
import { blockedByCycleRule } from './blockedByCycle.js';
import { blockedByRefsRule } from './blockedByRefs.js';
import { dependencyCycleRule } from './dependencyCycle.js';
import { dependencyRefsRule } from './dependencyRefs.js';
import { duplicateIdsRule } from './duplicateIds.js';
import { epicRefsRule } from './epicRefs.js';
import { laneOrphanRule } from './laneOrphan.js';
import { queuedDependencyShippedRule } from './queuedDependencyShipped.js';
import { queueLaneRule } from './queueLane.js';
import { queueDuplicateRule, queueRefsRule } from './queueRefs.js';
import { queueStatusRule } from './queueStatusRules.js';
import { reviewConflictRule } from './reviewConflict.js';
import { reviewIntegrityRule } from './reviewIntegrity.js';
import { reviewRefsRule } from './reviewRefs.js';
import { shippedFieldsRule } from './shippedFields.js';
import { sprintEpicMembershipRule } from './sprintEpicMembership.js';
import { sprintPolicyRule } from './sprintPolicy.js';

export const rules: readonly ValidatorRule[] = [
  duplicateIdsRule,
  sprintPolicyRule,
  queueRefsRule,
  queueDuplicateRule,
  queueLaneRule,
  laneOrphanRule,
  epicRefsRule,
  dependencyRefsRule,
  dependencyCycleRule,
  blockedByRefsRule,
  blockedByCycleRule,
  queuedDependencyShippedRule,
  activeFieldsRule,
  shippedFieldsRule,
  reviewRefsRule,
  reviewIntegrityRule,
  reviewConflictRule,
  sprintEpicMembershipRule,
  queueStatusRule,
];
